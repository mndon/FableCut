/* ═══════════════════════════════════════════════════════════════════════════
   FableCut server — zero-dependency Node.js
   Run:  node server.js   →  http://localhost:7777

   Adds to the browser editor:
     • project workspaces      ./projects/<id>/    (GET/POST /api/projects)
     • persistent timelines    project.json        (GET/PUT /api/project?project=<id>)
     • project-local media     media/               (POST /api/upload?project=<id>)
     • per-project live reload GET /api/events?project=<id>

   Automation: any tool (e.g. Claude Code) can edit a workspace project.json or
   drop files into its media/ — the matching browser UI reloads instantly.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, spawnSync, execFile } = require("child_process");

const { analyze } = require("./analyze");

const {
  APP_DIR, DATA_DIR, PROJECTS_DIR, LIBRARY_DIR, LIBRARY_SUBDIRS,
  DEFAULT_PROJECT_ID, normalizeProjectId, projectPaths, ensureProject,
  listProjects, ensureDirs,
} = require("./paths");

/* Static app files are served from the install dir; everything the user creates
   lives under DATA_DIR. The two are the same unless FABLECUT_DATA_DIR is set. */
const ROOT = APP_DIR;
const PORT = process.env.PORT || 7777;
const HOST = process.env.HOST || "127.0.0.1";

/* Requests must come from the local machine (or an explicitly allowed host).
   The Host check stops DNS rebinding; the Origin check stops malicious web
   pages firing blind cross-origin writes at the API. Opt into LAN use with
   HOST=0.0.0.0 and FABLECUT_ALLOWED_HOSTS=192.168.1.20,mybox.local */
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", HOST.toLowerCase()]);
for (const h of (process.env.FABLECUT_ALLOWED_HOSTS || "").split(","))
  if (h.trim()) ALLOWED_HOSTS.add(h.trim().toLowerCase());

function hostAllowed(value) {
  if (!value) return false;
  // strip a :port suffix, but not the colons inside a bare IPv6 address
  const host = value.replace(/^(\[[^\]]*\]|[^:]+)(:\d+)?$/, "$1").toLowerCase();
  return ALLOWED_HOSTS.has(host);
}
function requestAllowed(req) {
  if (!hostAllowed(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { return hostAllowed(new URL(origin).host); } catch { return false; }
  }
  return true;
}

/* ffmpeg powers optional niceties (faststart remux on upload, fast export).
   Everything else works without it. */
let HAS_FFMPEG = false;
try { HAS_FFMPEG = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; } catch {}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".mkv": "video/x-matroska", ".m4v": "video/mp4",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
  ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
};

ensureDirs();

/* ── SSE clients + file watching ── */
const sseClients = new Set();
function broadcast(projectId, kind = "change") {
  for (const client of sseClients)
    if (!projectId || client.projectId === projectId) client.res.write(`data: ${kind}\n\n`);
}
const debounces = new Map();
function onFsChange(projectId) {
  clearTimeout(debounces.get(projectId));
  debounces.set(projectId, setTimeout(() => broadcast(projectId), 150));
}
const watchedProjects = new Set();
function watchProject(projectId) {
  if (watchedProjects.has(projectId)) return;
  const pp = ensureProject(projectId);
  watchedProjects.add(projectId);
  try { fs.watch(pp.dir, (_ev, f) => { if (f === "project.json") onFsChange(projectId); }); } catch {}
  try { fs.watch(pp.mediaDir, () => onFsChange(projectId)); } catch {}
}
for (const p of listProjects()) watchProject(p.id);
let projectsDebounce = null;
try {
  fs.watch(PROJECTS_DIR, () => {
    clearTimeout(projectsDebounce);
    projectsDebounce = setTimeout(() => broadcast(null, "projects"), 150);
  });
} catch {}
for (const d of LIBRARY_SUBDIRS) {
  try { fs.watch(path.join(LIBRARY_DIR, d), () => broadcast(null)); } catch {}
}

/* ── Helpers ── */
function safeName(name) {
  return name.replace(/[^\w.\- ()\[\]]+/g, "_").slice(0, 120) || "file";
}
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function uniquePath(dir, name) {
  let target = path.join(dir, name);
  const ext = path.extname(name), base = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${base}_${i++}${ext}`);
  return target;
}
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 24 }, (err, _out, stderr) =>
      err ? reject(new Error((stderr || String(err)).slice(-800))) : resolve());
  });
}
function requestProject(url) {
  const id = normalizeProjectId(url.searchParams.get("project") || DEFAULT_PROJECT_ID);
  const pp = projectPaths(id);
  if (!fs.existsSync(pp.projectFile)) throw new Error("no such project: " + id);
  watchProject(id);
  return pp;
}
function projectMediaSrc(id, name) {
  return "/projects/" + encodeURIComponent(id) + "/media/" + encodeURIComponent(name);
}

/* Remux MP4-family uploads with `+faststart` so the moov atom leads the file —
   without it <video> stalls for seconds probing over Range requests. */
const FASTSTART_EXT = new Set([".mp4", ".mov", ".m4v"]);
async function faststart(file) {
  if (!HAS_FFMPEG || !FASTSTART_EXT.has(path.extname(file).toLowerCase())) return;
  const tmp = file + ".fs" + path.extname(file);
  try {
    await run("ffmpeg", ["-y", "-i", file, "-c", "copy", "-movflags", "+faststart", tmp]);
    fs.rmSync(file);
    fs.renameSync(tmp, file);
  } catch { try { fs.rmSync(tmp); } catch {} }
}

/* ── Fast export sessions ──
   The browser renders frames with its own compositor and streams them here as
   JPEGs; ffmpeg encodes them (plus an optional WAV mix) into a real MP4. */
const exportSessions = new Map();
function beginExport(fps, name, projectId) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-"));
  const videoPath = path.join(dir, "video.mp4");
  const proc = spawn("ffmpeg", [
    "-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    // The browser's JPEG frames are full-range BT.601 (JFIF). Convert them to
    // limited-range BT.709 and TAG the stream, otherwise x264 emits bt470bg/pc/
    // unknown and players do the wrong YUV->RGB conversion — the render comes
    // out darker than the preview.
    "-vf", "scale=in_range=full:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-color_range", "tv",
    videoPath,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  proc.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  proc.stdin.on("error", () => {}); // EPIPE if ffmpeg dies mid-stream; surfaced via exit code
  const sess = {
    proc, dir, videoPath, name: safeName(name || "export"), projectId,
    wav: null, err: () => stderr,
    done: new Promise((res) => proc.on("close", res)),
  };
  exportSessions.set(id, sess);
  return id;
}
function cleanupExport(id) {
  const s = exportSessions.get(id);
  if (!s) return;
  exportSessions.delete(id);
  try { s.proc.kill(); } catch {}
  try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch {}
}

/* Static file with HTTP Range support (required for <video> seeking) */
function serveFile(req, res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("Not found"); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1]) : 0;
      let end = m && m[2] ? parseInt(m[2]) : st.size - 1;
      start = Math.min(start, st.size - 1); end = Math.min(end, st.size - 1);
      res.writeHead(206, {
        "Content-Type": type, "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${st.size}`,
        "Content-Length": end - start + 1,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        "Content-Type": type, "Content-Length": st.size,
        "Accept-Ranges": "bytes", "Cache-Control": "no-cache",
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

/* ── Server ── */
const server = http.createServer(async (req, res) => {
  if (!requestAllowed(req)) {
    sendJSON(res, 403, { error: "forbidden: request must come from this machine (bad Host or Origin header)" });
    return;
  }
  const url = new URL(req.url, "http://localhost");
  const p = decodeURIComponent(url.pathname);
  // never serve dotfiles/dot-directories (.git, .gitignore, …)
  if (p.split(/[\\/]/).some((seg) => seg.startsWith("."))) { res.writeHead(403); res.end(); return; }

  /* API: project workspaces */
  if (p === "/api/projects" && req.method === "GET") {
    sendJSON(res, 200, listProjects());
    return;
  }
  if (p === "/api/projects" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const name = String(body.name || "Untitled Project").trim() || "Untitled Project";
      const stem = String(body.id || name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
      let id = normalizeProjectId(stem.slice(0, 56)), n = 2;
      while (fs.existsSync(projectPaths(id).dir)) id = normalizeProjectId(`${stem.slice(0, 56)}-${n++}`);
      ensureProject(id, name);
      watchProject(id);
      broadcast(null, "projects");
      sendJSON(res, 201, { id, name });
    } catch (e) { sendJSON(res, 400, { error: String(e) }); }
    return;
  }

  /* API: selected project (query parameter: ?project=<id>) */
  if (p === "/api/project" && req.method === "GET") {
    // strip UTF-8 BOM some editors/PowerShell prepend, which breaks JSON.parse
    try {
      const pp = requestProject(url);
      sendJSON(res, 200, JSON.parse(fs.readFileSync(pp.projectFile, "utf8").replace(new RegExp("^\\uFEFF"), "")));
    }
    catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/project" && req.method === "PUT") {
    try {
      const pp = requestProject(url);
      const body = await readBody(req);
      const data = JSON.parse(body.toString("utf8")); // validate JSON
      /* Optimistic concurrency: a write whose revision isn't newer than what's
         on disk was based on a stale read (someone else — the UI or an external
         tool — saved in between). Reject it instead of clobbering their work.
         ?force=1 skips the check for deliberate overwrites. */
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(pp.projectFile, "utf8").replace(new RegExp("^\\uFEFF"), "")); } catch {}
      if ((data.revision || 0) <= (cur.revision || 0) && url.searchParams.get("force") !== "1") {
        sendJSON(res, 409, { error: "stale revision — project changed since it was read", revision: cur.revision || 0 });
        return;
      }
      const tmp = pp.projectFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, pp.projectFile);
      sendJSON(res, 200, { ok: true, revision: data.revision });
    } catch (e) { sendJSON(res, 400, { error: String(e) }); }
    return;
  }

  /* API: media library listing */
  if (p === "/api/media" && req.method === "GET") {
    try {
      const pp = requestProject(url);
      const files = fs.readdirSync(pp.mediaDir)
        .filter((f) => fs.statSync(path.join(pp.mediaDir, f)).isFile())
        .map((f) => ({ name: f, src: projectMediaSrc(pp.id, f), size: fs.statSync(path.join(pp.mediaDir, f)).size }));
      sendJSON(res, 200, files);
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: default-asset library listing (./library/{sfx,elements,svg,fonts}) */
  if (p === "/api/library" && req.method === "GET") {
    const dir = url.searchParams.get("dir");
    if (!LIBRARY_SUBDIRS.includes(dir)) { sendJSON(res, 400, { error: "dir must be one of " + LIBRARY_SUBDIRS.join("|") }); return; }
    try {
      const base = path.join(LIBRARY_DIR, dir);
      const out = [];
      const walk = (d, rel) => {
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f), r = rel ? rel + "/" + f : f;
          const st = fs.statSync(full);
          if (st.isDirectory()) walk(full, r);
          else out.push({
            name: f, rel: r, size: st.size,
            src: "/library/" + dir + "/" + r.split("/").map(encodeURIComponent).join("/"),
          });
        }
      };
      walk(base, "");
      sendJSON(res, 200, out);
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: upload → saved into ./media */
  if (p === "/api/upload" && req.method === "POST") {
    try {
      const pp = requestProject(url);
      let name = safeName(url.searchParams.get("name") || "upload.bin");
      let target = path.join(pp.mediaDir, name);
      let i = 1;
      const ext = path.extname(name), base = path.basename(name, ext);
      while (fs.existsSync(target)) target = path.join(pp.mediaDir, `${base}_${i++}${ext}`);
      const body = await readBody(req);
      fs.writeFileSync(target, body);
      await faststart(target);
      sendJSON(res, 200, { ok: true, src: projectMediaSrc(pp.id, path.basename(target)) });
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: fast export (browser-rendered frames → ffmpeg encode) */
  if (p === "/api/export/ffmpeg" && req.method === "GET") {
    sendJSON(res, 200, { available: HAS_FFMPEG });
    return;
  }
  if (p === "/api/export/begin" && req.method === "POST") {
    if (!HAS_FFMPEG) { sendJSON(res, 400, { error: "ffmpeg not found on PATH" }); return; }
    try {
      const pp = requestProject(url);
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      sendJSON(res, 200, { id: beginExport(opts.fps || 30, opts.name, pp.id) });
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/export/frame" && req.method === "POST") {
    const sess = exportSessions.get(url.searchParams.get("id"));
    if (!sess) { sendJSON(res, 404, { error: "no such export session" }); return; }
    try {
      const body = await readBody(req);
      if (sess.proc.exitCode !== null) throw new Error("ffmpeg exited: " + sess.err());
      if (!sess.proc.stdin.write(body))
        await new Promise((r) => sess.proc.stdin.once("drain", r));
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/export/audio" && req.method === "POST") {
    const sess = exportSessions.get(url.searchParams.get("id"));
    if (!sess) { sendJSON(res, 404, { error: "no such export session" }); return; }
    try {
      sess.wav = path.join(sess.dir, "audio.wav");
      fs.writeFileSync(sess.wav, await readBody(req));
      sendJSON(res, 200, { ok: true });
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/export/end" && req.method === "POST") {
    const id = url.searchParams.get("id");
    const sess = exportSessions.get(id);
    if (!sess) { sendJSON(res, 404, { error: "no such export session" }); return; }
    try {
      if (url.searchParams.get("discard")) { cleanupExport(id); sendJSON(res, 200, { ok: true }); return; }
      sess.proc.stdin.end();
      const code = await sess.done;
      if (code !== 0) throw new Error("ffmpeg encode failed: " + sess.err());
      const pp = ensureProject(sess.projectId);
      const out = uniquePath(pp.exportsDir, sess.name.replace(/\.mp4$/i, "") + ".mp4");
      // Re-assert the bt709 tags on the mux — a stream-copy pass can drop the
      // container-level colr atom even though the SPS still carries them.
      const TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709",
                    "-color_trc", "bt709", "-color_range", "tv"];
      if (sess.wav && fs.existsSync(sess.wav))
        await run("ffmpeg", ["-y", "-i", sess.videoPath, "-i", sess.wav,
          "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest",
          ...TAGS, "-movflags", "+faststart", out]);
      else
        await run("ffmpeg", ["-y", "-i", sess.videoPath, "-c", "copy",
          ...TAGS, "-movflags", "+faststart", out]);
      cleanupExport(id);
      sendJSON(res, 200, { ok: true, src: "/projects/" + encodeURIComponent(pp.id) + "/exports/" + encodeURIComponent(path.basename(out)) });
    } catch (e) { cleanupExport(id); sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: reference analysis → edit blueprint (shots, beats, BPM, energy, music).
     POST body {src:"/media/ref.mp4", threshold?, music?} runs the analysis
     (seconds to ~a minute — decode-bound); GET ?src= returns the cached result. */
  if (p === "/api/analyze" && req.method === "GET") {
    let pp;
    try { pp = requestProject(url); } catch (e) { sendJSON(res, 400, { error: String(e) }); return; }
    const src = decodeURIComponent(url.searchParams.get("src") || "");
    const f = path.join(pp.analysisDir, path.basename(src, path.extname(src)) + ".json");
    if (!src || !fs.existsSync(f)) { sendJSON(res, 404, { error: "no cached analysis for that src — POST /api/analyze first" }); return; }
    try { sendJSON(res, 200, JSON.parse(fs.readFileSync(f, "utf8"))); }
    catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }
  if (p === "/api/analyze" && req.method === "POST") {
    if (!HAS_FFMPEG) { sendJSON(res, 400, { error: "ffmpeg not found on PATH" }); return; }
    try {
      const pp = requestProject(url);
      const opts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const name = path.basename(decodeURIComponent(opts.src || ""));
      const file = path.join(pp.mediaDir, name);
      if (!name || !fs.existsSync(file)) { sendJSON(res, 404, { error: "src must name an existing file under /media/" }); return; }
      const bp = await analyze(file, {
        threshold: opts.threshold,
        music: opts.music !== false,
        musicDir: pp.mediaDir,
        srcUrl: projectMediaSrc(pp.id, name),
      });
      if (bp.music) bp.music.src = projectMediaSrc(pp.id, bp.music.name);
      fs.writeFileSync(path.join(pp.analysisDir, path.basename(name, path.extname(name)) + ".json"),
        JSON.stringify(bp, null, 2));
      sendJSON(res, 200, bp);
    } catch (e) { sendJSON(res, 500, { error: String(e) }); }
    return;
  }

  /* API: SSE live-reload channel */
  if (p === "/api/events") {
    let pp;
    try { pp = requestProject(url); } catch (e) { sendJSON(res, 400, { error: String(e) }); return; }
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("data: hello\n\n");
    const client = { res, projectId: pp.id };
    sseClients.add(client);
    req.on("close", () => sseClients.delete(client));
    return;
  }

  /* Project media and finished exports. Canonical URLs include the project id,
     so multiple projects can be open in different tabs without shared state. */
  const projectAsset = /^\/projects\/([a-z0-9_-]+)\/(media|exports)\/(.+)$/.exec(p);
  if (projectAsset) {
    try {
      const pp = projectPaths(projectAsset[1]);
      if (!fs.existsSync(pp.projectFile)) throw new Error("no such project");
      const dir = projectAsset[2] === "media" ? pp.mediaDir : pp.exportsDir;
      serveFile(req, res, path.join(dir, path.basename(projectAsset[3])));
    } catch { res.writeHead(404); res.end("Not found"); }
    return;
  }
  /* v1 URL compatibility for the migrated default project. */
  if (p.startsWith("/media/") || p.startsWith("/exports/")) {
    const pp = ensureProject(DEFAULT_PROJECT_ID);
    const dir = p.startsWith("/media/") ? pp.mediaDir : pp.exportsDir;
    serveFile(req, res, path.join(dir, path.basename(p)));
    return;
  }

  /* Library assets (supports subfolders) */
  if (p.startsWith("/library/")) {
    const file = path.normalize(path.join(LIBRARY_DIR, p.slice("/library/".length)));
    if (!file.startsWith(LIBRARY_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    serveFile(req, res, file);
    return;
  }

  /* Static app files */
  let file = p === "/" ? "/index.html" : p;
  file = path.normalize(path.join(ROOT, file));
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
  serveFile(req, res, file);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  FableCut running →  http://localhost:${PORT}\n`);
  if (!["127.0.0.1", "localhost", "::1"].includes(HOST))
    console.log(`  ⚠ WARNING: HOST=${HOST} exposes the editor (and its file APIs) to the network.\n`);
  console.log(`  projects     : ${PROJECTS_DIR} (${listProjects().length})`);
  console.log(`  library      : ${LIBRARY_DIR} (${LIBRARY_SUBDIRS.join(", ")})`);
  if (DATA_DIR !== APP_DIR) console.log(`  app files    : ${APP_DIR}`);
  console.log(`  ffmpeg       : ${HAS_FFMPEG ? "found (fast export + faststart remux on)" : "not found (real-time export only)"}\n`);
});
