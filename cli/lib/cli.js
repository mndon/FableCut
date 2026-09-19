"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { pipeline } = require("stream/promises");
const { URL } = require("url");
class CliError extends Error {
  constructor(message, exitCode = 1) { super(message); this.exitCode = exitCode; }
}

function networkErrorMessage(error) {
  const describe = (item) => {
    if (!item) return "";
    const location = item.address && item.port ? ` ${item.address}:${item.port}` : "";
    return String(item.message || ([item.code, location].filter(Boolean).join(" "))).trim();
  };
  if (Array.isArray(error && error.errors)) {
    const details = [...new Set(error.errors.map(describe).filter(Boolean))];
    if (details.length) return details.join("; ");
  }
  return describe(error) || String(error || "unknown network error");
}

function parseArgs(argv) {
  const positionals = [], options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) { positionals.push(arg); continue; }
    const eq = arg.indexOf("=");
    const key = arg.slice(2, eq < 0 ? undefined : eq);
    if (eq >= 0) options[key] = arg.slice(eq + 1);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) options[key] = argv[++i];
    else options[key] = true;
  }
  return { positionals, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (value === undefined || value === true || value === "") throw new CliError("Missing required option --" + key);
  return String(value);
}

function parseJSON(value, label, kind) {
  let data;
  try { data = JSON.parse(value); } catch (error) { throw new CliError(`${label} is not valid JSON: ${error.message}`); }
  if (kind === "array" ? !Array.isArray(data) : !data || Array.isArray(data) || typeof data !== "object")
    throw new CliError(`${label} must be a JSON ${kind}`);
  return data;
}

function runtimeDir() {
  const packaged = path.resolve(__dirname, "../runtime");
  if (fs.existsSync(path.join(packaged, "server.js"))) return packaged;
  throw new CliError("FableCut runtime is missing; run 'npm run sync-runtime' in the CLI source directory or reinstall tik-editvideo-cli");
}

// HTTP is used only to drive the local browser export and retrieve its output.
class ExportClient {
  constructor(rawUrl) {
    try { this.base = new URL(rawUrl); } catch { throw new CliError("Server URL must be a valid local HTTP URL"); }
    if (this.base.protocol !== "http:") throw new CliError("Local server URL must use http");
    if (this.base.username || this.base.password || this.base.search || this.base.hash)
      throw new CliError("Server URL must not contain credentials, query parameters, or a fragment");
    this.basePath = this.base.pathname.replace(/\/$/, "");
  }

  target(apiPath, query = {}) {
    const url = new URL(this.base.href);
    url.pathname = this.basePath + "/" + apiPath.replace(/^\//, "");
    url.search = "";
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
    return url;
  }

  request(method, apiPath, { query, response = "json" } = {}) {
    const url = this.target(apiPath, query);
    const headers = { Accept: response === "json" ? "application/json" : "*/*", "User-Agent": "tik-editvideo-cli/1" };
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers, timeout: 120000 }, (res) => {
        if (response === "stream" && res.statusCode >= 200 && res.statusCode < 300) { resolve(res); return; }
        const chunks = [];
        res.on("error", reject);
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          let data = text;
          if (text) { try { data = JSON.parse(text); } catch {} }
          else data = {};
          if (res.statusCode >= 300 && res.statusCode < 400)
            return reject(new CliError(`HTTP ${res.statusCode}: unexpected redirect from local service`));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const detail = data && typeof data === "object" ? data.error || data.message : data;
            const error = new CliError(`HTTP ${res.statusCode}: ${detail || res.statusMessage}`);
            error.status = res.statusCode; reject(error); return;
          }
          resolve(data);
        });
      });
      req.on("timeout", () => req.destroy(new CliError("Request timed out")));
      req.on("error", (error) => {
        if (error instanceof CliError) { reject(error); return; }
        const hint = url.hostname === "127.0.0.1" || url.hostname === "localhost"
          ? " Is the server running? Start it with: tik-editvideo-cli status"
          : "";
        reject(new CliError(`Request to ${url.origin} failed: ${networkErrorMessage(error)}.${hint}`));
      });
      req.end();
    });
  }
}

function requireProject(project) {
  if (!project || typeof project !== "object" || !Array.isArray(project.clips) || !Array.isArray(project.media))
    throw new CliError("Project must be an object containing clips and media arrays");
  return project;
}

function validateDocument(project) {
  for (const media of project.media) if (media && media.asrUrl !== undefined) validateAsrUrl(media.asrUrl);
  const mediaIds = new Set(project.media.filter((x) => x && typeof x === "object").map((x) => x.id));
  for (const clip of project.clips) {
    if (!clip || typeof clip !== "object") throw new CliError("Each clip must be an object");
    if (!clip.id || !clip.track || !Number.isFinite(clip.start) || !Number.isFinite(clip.duration))
      throw new CliError(`Clip ${clip.id || "(unknown)"} must have id, track, numeric start, and numeric duration`);
    if (!new Set(["text", "adjust"]).has(clip.kind) && !mediaIds.has(clip.mediaId))
      throw new CliError(`Clip ${clip.id} references unknown mediaId: ${clip.mediaId}`);
  }
}

function validateAsrUrl(value) {
  try {
    const url = typeof value === "string" && new URL(value);
    if (!url || !/^https?:\/\//i.test(value) || !/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password || /[\s\\]/.test(value))
      throw new Error("invalid URL");
  } catch {
    throw new CliError("asrUrl / --asr-url must be an absolute HTTP(S) URL without credentials");
  }
  return value;
}

function newId(prefix) { return prefix + require("crypto").randomBytes(4).toString("hex"); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function mergeInto(target, changes) {
  if (changes == null) return;
  if (typeof changes !== "object" || Array.isArray(changes)) throw new CliError("set must be a JSON object");
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete target[key];
    else if (key === "props" && target.props && typeof target.props === "object" && value && typeof value === "object") {
      for (const [prop, propValue] of Object.entries(value)) {
        if (propValue === null) delete target.props[prop]; else target.props[prop] = propValue;
      }
    } else target[key] = value;
  }
}

function applyOps(project, ops) {
  if (!Array.isArray(ops) || !ops.length) throw new CliError("--ops must be a non-empty JSON array");
  const result = clone(requireProject(project)), notes = [];
  for (const operation of ops) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new CliError("Each op must be an object");
    if (operation.op === "addClip") {
      const clip = clone(operation.clip || {});
      if (!clip.track || !Number.isFinite(clip.start) || !Number.isFinite(clip.duration))
        throw new CliError("addClip requires clip.track plus numeric clip.start and clip.duration");
      clip.id ||= newId("c_");
      if (result.clips.some((item) => item.id === clip.id)) throw new CliError("addClip duplicate clip id: " + clip.id);
      if (!["text", "adjust"].includes(clip.kind) && !result.media.some((item) => item.id === clip.mediaId))
        throw new CliError("addClip unknown mediaId: " + clip.mediaId);
      result.clips.push(clip); notes.push("+" + clip.id);
    } else if (operation.op === "updateClip") {
      const clip = result.clips.find((item) => item.id === operation.id);
      if (!clip) throw new CliError("updateClip cannot find clip: " + operation.id);
      mergeInto(clip, operation.set); notes.push("~" + operation.id);
    } else if (operation.op === "removeClip") {
      const index = result.clips.findIndex((item) => item.id === operation.id);
      if (index < 0) throw new CliError("removeClip cannot find clip: " + operation.id);
      result.clips.splice(index, 1); notes.push("-" + operation.id);
    } else if (operation.op === "addMedia") {
      const media = clone(operation.media || {});
      if (!media.src || !media.kind) throw new CliError("addMedia requires media.src and media.kind");
      if (media.asrUrl !== undefined) validateAsrUrl(media.asrUrl);
      media.id ||= newId("m_"); media.name ||= decodeURIComponent(path.basename(media.src));
      if (result.media.some((item) => item.id === media.id)) throw new CliError("addMedia duplicate media id: " + media.id);
      result.media.push(media); notes.push("+" + media.id);
    } else if (operation.op === "removeMedia") {
      const used = result.clips.find((clip) => clip.mediaId === operation.id);
      if (used) throw new CliError(`removeMedia is used by clip ${used.id}`);
      const index = result.media.findIndex((item) => item.id === operation.id);
      if (index < 0) throw new CliError("removeMedia cannot find media: " + operation.id);
      result.media.splice(index, 1); notes.push("-" + operation.id);
    } else if (operation.op === "setProject") {
      const changes = operation.set || {};
      const allowed = new Set(["name", "width", "height", "fps", "background", "markers", "disabledTracks"]);
      const unknown = Object.keys(changes).filter((key) => !allowed.has(key));
      if (unknown.length) throw new CliError("setProject cannot modify: " + unknown.join(", "));
      for (const [key, value] of Object.entries(changes)) { if (value === null) delete result[key]; else result[key] = value; }
      notes.push("~project");
    } else throw new CliError("Unknown op; use addClip, updateClip, removeClip, addMedia, removeMedia, or setProject");
  }
  result.revision = Number(result.revision || 0) + 1;
  return { project: result, notes };
}

async function getProject(client, id) { return requireProject(await client.request("GET", "/api/project", { query: { project: id } })); }
const DEFAULT_PROPS = { x:0,y:0,scale:1,rotation:0,opacity:1,volume:1,speed:1,blend:"normal",fit:"contain",cropL:0,cropR:0,cropT:0,cropB:0,cornerRadius:0,flipH:false,flipV:false,filterPreset:"none",brightness:100,contrast:100,saturation:100,hue:0,temperature:0,tint:0,blur:0,grayscale:0,sepia:0,invert:0,vignette:0,shake:0,shakeSpeed:8,rgbSplit:0,grain:0,chromaKey:"",chromaTolerance:26,chromaSoftness:12,bgRemove:false,text:"Title",fontSize:72,color:"#ffffff",color2:"",font:"Segoe UI",bold:true,weight:0,italic:false,uppercase:false,align:"center",letterSpacing:0,lineHeight:1.2,textShadow:12,glow:0,glowColor:"",strokeWidth:0,strokeColor:"#000",bgColor:"#000",bgOpacity:0,textAnim:"none",wordRate:0.15 };
function number(value) { return typeof value === "number" ? String(Math.round(value * 1000) / 1000) : String(value); }
function compactProject(id, project) {
  const duration = project.clips.reduce((max, clip) => Math.max(max, Number(clip.start || 0) + Number(clip.duration || 0)), 0);
  const lines = [`Project ${id} | ${project.name || ""} | ${project.width}x${project.height} @${project.fps}fps | ${number(duration)}s | revision ${project.revision || 0}`, `Media ${project.media.length} | Clips ${project.clips.length}`];
  for (const media of project.media) lines.push(`M ${media.id} ${media.kind} ${media.name || ""}${media.duration == null ? "" : " " + number(media.duration) + "s"}${media.asrUrl ? " asr=yes" : ""}`);
  for (const clip of [...project.clips].sort((a, b) => String(a.track).localeCompare(String(b.track)) || Number(a.start) - Number(b.start))) {
    const props = Object.fromEntries(Object.entries(clip.props || {}).filter(([key, value]) => !(key in DEFAULT_PROPS) || DEFAULT_PROPS[key] !== value));
    const extras = [];
    if (Object.keys(props).length) extras.push("props=" + JSON.stringify(props));
    if (clip.keyframes) extras.push("keys=" + Object.keys(clip.keyframes).sort().join(","));
    if (clip.transitionIn) extras.push("inTransition=" + JSON.stringify(clip.transitionIn));
    if (clip.transitionOut) extras.push("outTransition=" + JSON.stringify(clip.transitionOut));
    lines.push(`C ${clip.id} ${clip.track} ${clip.kind} start=${number(clip.start || 0)} in=${number(clip.in || 0)} duration=${number(clip.duration || 0)} media=${clip.mediaId}${extras.length ? " " + extras.join(" ") : ""}`);
  }
  return lines.join("\n");
}

const KIND_BY_EXT = new Map(Object.entries({ ".mp4":"video", ".webm":"video", ".mov":"video", ".mkv":"video", ".m4v":"video", ".avi":"video", ".mp3":"audio", ".wav":"audio", ".ogg":"audio", ".m4a":"audio", ".aac":"audio", ".flac":"audio", ".png":"image", ".jpg":"image", ".jpeg":"image", ".gif":"image", ".webp":"image", ".svg":"svg" }));

function findBrowser(explicit) {
  const candidates = [explicit, process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]
    .filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) { if (fs.existsSync(candidate)) return candidate; }
    else {
      const probe = spawnSync(process.platform === "win32" ? "where" : "which", [candidate], { encoding: "utf8" });
      if (probe.status === 0) return probe.stdout.split(/\r?\n/)[0].trim();
    }
  }
  throw new CliError("Chrome/Chromium was not found; install it or pass --browser <path>");
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function download(client, src, target, force) {
  if (fs.existsSync(target) && !force) throw new CliError(`Output already exists: ${target} (pass --force to replace it)`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + ".part-" + process.pid;
  try {
    const response = await client.request("GET", src, { response: "stream" });
    await pipeline(response, fs.createWriteStream(temporary));
    if (force) fs.rmSync(target, { force: true });
    fs.renameSync(temporary, target);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

async function exportProject(client, options) {
  const engine = options.engine === undefined ? "fast" : options.engine;
  if (!["fast", "optimized"].includes(engine)) throw new CliError("--engine must be fast or optimized");
  const projectId = requireOption(options, "project");
  const project = await getProject(client, projectId);
  const ffmpeg = await client.request("GET", "/api/export/ffmpeg");
  if (!ffmpeg.available) throw new CliError("The FableCut server cannot find ffmpeg on PATH");
  if (engine === "optimized" && !ffmpeg.ffprobe) throw new CliError("Optimized export requires ffprobe");
  const name = String(options.name || project.name || "export").replace(/[^\w\- ]+/g, "") || "export";
  const defaultFile = name.replace(/\s+/g, "-") + ".mp4";
  const output = path.resolve(String(options.output || defaultFile));
  const timeoutSeconds = Number(options.timeout || 3600);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new CliError("--timeout must be a positive number of seconds");
  if (fs.existsSync(output) && !options.force) throw new CliError(`Output already exists: ${output} (pass --force to replace it)`);
  const browserPath = findBrowser(options.browser === true ? undefined : options.browser);
  const requestId = require("crypto").randomBytes(16).toString("hex");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tik-editvideo-cli-chrome-"));
  const url = new URL(client.base.href);
  url.searchParams.set("project", projectId);
  url.searchParams.set("cliExport", requestId);
  url.searchParams.set("cliExportName", name);
  url.searchParams.set("cliExportEngine", engine);
  // HEVC playback in Chrome requires hardware decoding. Do not disable the GPU.
  const chrome = spawn(browserPath, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--user-data-dir=" + profile, "--window-size=1440,1000", url.href], { stdio: ["ignore", "ignore", "pipe"] });
  let launchError;
  chrome.on("error", (error) => { launchError = error; });
  const closed = new Promise((resolve) => chrome.once("close", resolve));
  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let status;
  try {
    while (Date.now() < deadline) {
      await delay(500);
      try { status = await client.request("GET", "/api/export/status", { query: { project: projectId, id: requestId } }); }
      catch (error) { if (error.status !== 404) throw error; }
      if (status?.state === "complete") break;
      if (status?.state === "error") throw new CliError("Export failed: " + status.error);
      if (launchError) throw new CliError("Chrome failed to start: " + launchError.message);
      if (chrome.exitCode !== null || chrome.signalCode !== null) throw new CliError(`Chrome exited before export completed${stderr ? ": " + stderr.trim().slice(-800) : ""}`);
    }
    if (!status || status.state !== "complete") throw new CliError(`Export timed out after ${timeoutSeconds} seconds`);
    await download(client, status.src, output, !!options.force);
    console.log(JSON.stringify({ ok: true, project: projectId, output, src: status.src, ...(status.metrics ? { metrics: status.metrics } : {}) }, null, 2));
  } finally {
    if (chrome.exitCode === null) chrome.kill();
    const killTimer = setTimeout(() => chrome.kill("SIGKILL"), 3000);
    try { await closed; } finally { clearTimeout(killTimer); }
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function printHelp() {
  console.log(`tik-editvideo-cli - local editing, preview, and export

Usage:
  tik-editvideo-cli list-projects
  tik-editvideo-cli create-project --name <name> [--id <id>]
  tik-editvideo-cli get-project --project <id> [--compact]
  tik-editvideo-cli patch-project --project <id> --ops '<JSON array>'
  tik-editvideo-cli set-project --project <id> --document '<JSON object>' [--force]
  tik-editvideo-cli import-media --project <id> --path <file> [--asr-url <url>]
  tik-editvideo-cli status [--project <id>] [--host <host>] [--port <port>]
  tik-editvideo-cli server start [--host <host>] [--port <port>]
  tik-editvideo-cli export --project <id> [--name <name>] [--output <mp4>] [--engine fast|optimized] [--force]
                     [--browser <path>] [--timeout <seconds>] [--host <host>] [--port <port>]

Editing works without a server. status starts a background preview server if needed;
export also starts it automatically. server start runs in the foreground.
Storage is fixed at .tik-editvideo-cli inside the OS user home directory.
HOST / PORT configure the local server (default 127.0.0.1:7777).
CHROME_PATH selects Chrome/Chromium for export. Export also requires ffmpeg.`);
}

async function main(argv = process.argv.slice(2)) {
  const { positionals, options } = parseArgs(argv);
  const command = positionals[0];
  if (!command || command === "help" || options.help) { printHelp(); return; }
  if (options["data-dir"] !== undefined) throw new CliError("--data-dir is no longer supported; storage is fixed at ~/.tik-editvideo-cli");
  if (options.url !== undefined || process.env.FABLECUT_URL?.trim())
    throw new CliError("Remote editing (--url / FABLECUT_URL) is no longer supported; unset FABLECUT_URL to use local projects");
  const commands = ["server", "status", "list-projects", "create-project", "get-project", "patch-project", "set-project", "import-media", "export"];
  if (!commands.includes(command)) throw new CliError("Unknown command: " + command + " (run tik-editvideo-cli --help)");
  if (command === "server" && positionals[1] !== "start") throw new CliError("Use: tik-editvideo-cli server start");
  const { initialize, ensureServer, connection } = require("./local");
  for (const key of ["host", "port"]) if (options[key] !== undefined) requireOption(options, key);
  const local = initialize(runtimeDir()), { store, paths } = local;
  const print = value => console.log(JSON.stringify(value, null, 2));
  if (command === "server") {
    const config = connection(options);
    process.env.HOST = config.host;
    process.env.PORT = String(config.port);
    require(path.join(local.runtime, "server.js"));
  } else if (command === "status") {
    if (options.project !== undefined) requireOption(options, "project");
    print(await ensureServer(local, options));
  } else if (command === "list-projects") print(paths.listProjects());
  else if (command === "create-project") print(store.create(requireOption(options, "name"), options.id === undefined ? undefined : requireOption(options, "id")));
  else if (command === "get-project") {
    const id = store.context(requireOption(options, "project")).id, project = requireProject(store.read(id));
    console.log(options.compact ? compactProject(id, project) : JSON.stringify(project, null, 2));
  } else if (command === "patch-project") {
    const id = store.context(requireOption(options, "project")).id;
    const ops = parseJSON(requireOption(options, "ops"), "--ops", "array");
    let changes;
    const project = store.update(id, current => {
      const result = applyOps(current, ops);
      validateDocument(result.project);
      changes = result.notes;
      return result.project;
    });
    print({ ok: true, project: id, revision: project.revision, clips: project.clips.length, media: project.media.length, changes });
  } else if (command === "set-project") {
    const id = store.context(requireOption(options, "project")).id;
    const project = requireProject(parseJSON(requireOption(options, "document"), "--document", "object"));
    validateDocument(project);
    const saved = store.update(id, current => {
      if (!options.force && Number(project.revision || 0) !== Number(current.revision || 0)) {
        throw new CliError("CONFLICT — stale revision; read the latest project and reapply your changes");
      }
      return { ...project, revision: Number(current.revision || 0) + 1 };
    });
    print({ ok: true, project: id, revision: saved.revision, response: { ok: true, revision: saved.revision } });
  } else if (command === "import-media") {
    const id = store.context(requireOption(options, "project")).id, source = path.resolve(requireOption(options, "path"));
    const asrUrl = options["asr-url"] === undefined ? undefined : validateAsrUrl(requireOption(options, "asr-url"));
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new CliError("Media file not found: " + source);
    const kind = KIND_BY_EXT.get(path.extname(source).toLowerCase());
    if (!kind) throw new CliError("Unsupported media extension: " + (path.extname(source) || "(none)"));
    const pp = store.context(id);
    const base = path.basename(source).replace(/[^\w.\- ()\[\]]+/g, "_").slice(0, 120) || "file";
    const ext = path.extname(base), stem = path.basename(base, ext);
    let target = path.join(pp.mediaDir, base), n = 1;
    for (;;) {
      try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; target = path.join(pp.mediaDir, `${stem}_${n++}${ext}`); }
    }
    const media = { id: newId("m_"), name: path.basename(target), kind, src: `/projects/${id}/media/${encodeURIComponent(path.basename(target))}` };
    if (asrUrl !== undefined) media.asrUrl = asrUrl;
    // Probe locally when available; editing never needs the browser to fill duration.
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", target], { encoding: "utf8", timeout: 15000 });
    if (probe.status === 0) {
      try {
        const info = JSON.parse(probe.stdout), duration = Number(info.format?.duration);
        if (Number.isFinite(duration) && duration > 0) media.duration = duration;
        const visual = info.streams?.find(stream => stream.width && stream.height);
        if (visual) { media.width = visual.width; media.height = visual.height; }
      } catch {}
    }
    let project;
    try { project = store.update(id, current => applyOps(current, [{ op: "addMedia", media }]).project); }
    catch (error) { fs.rmSync(target, { force: true }); throw error; }
    print({ ok: true, project: id, revision: project.revision, media });
  } else if (command === "export") {
    if (options.engine !== undefined && !["fast", "optimized"].includes(options.engine)) throw new CliError("--engine must be fast or optimized");
    requireOption(options, "project");
    const status = await ensureServer(local, options);
    await exportProject(new ExportClient(status.url), options);
  }
}

module.exports = { main, applyOps, compactProject };
