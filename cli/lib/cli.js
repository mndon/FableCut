"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { pipeline } = require("stream/promises");
const { URL } = require("url");
const DEFAULT_DATA_DIR = path.join(os.homedir(), ".fablecut");

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

class Client {
  constructor(rawUrl = process.env.FABLECUT_URL || "http://127.0.0.1:7777") {
    try { this.base = new URL(rawUrl); } catch { throw new CliError("FABLECUT_URL must be a valid HTTP(S) URL"); }
    if (!/^https?:$/.test(this.base.protocol)) throw new CliError("FABLECUT_URL must use http or https");
    if (this.base.username || this.base.password || this.base.search || this.base.hash)
      throw new CliError("FABLECUT_URL must not contain credentials, query parameters, or a fragment");
    this.token = (process.env.FABLECUT_TOKEN || "").trim();
    this.basePath = this.base.pathname.replace(/\/$/, "");
  }

  target(apiPath, query = {}) {
    const url = new URL(this.base.href);
    url.pathname = this.basePath + "/" + apiPath.replace(/^\//, "");
    url.search = "";
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
    return url;
  }

  request(method, apiPath, { query, json, file, response = "json" } = {}) {
    if (json !== undefined && file) throw new CliError("A request cannot contain both JSON and a file");
    const url = this.target(apiPath, query);
    const transport = url.protocol === "https:" ? https : http;
    const headers = { Accept: response === "json" ? "application/json" : "*/*", "User-Agent": "tik-editvideo-cli/1" };
    if (this.token) headers.Authorization = "Bearer " + this.token;
    let body = null;
    if (json !== undefined) {
      body = Buffer.from(JSON.stringify(json));
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = body.length;
    } else if (file) {
      headers["Content-Length"] = fs.statSync(file).size;
      headers["Content-Type"] = "application/octet-stream";
    }
    return new Promise((resolve, reject) => {
      const req = transport.request(url, { method, headers, timeout: 120000 }, (res) => {
        if (response === "stream" && res.statusCode >= 200 && res.statusCode < 300) { resolve(res); return; }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          let data = text;
          if (text) { try { data = JSON.parse(text); } catch {} }
          else data = {};
          if (res.statusCode >= 300 && res.statusCode < 400)
            return reject(new CliError(`HTTP ${res.statusCode}: redirect refused to protect credentials`));
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
          ? " Is the server running? Start it with: tik-editvideo-cli server start"
          : "";
        reject(new CliError(`Request to ${url.origin} failed: ${networkErrorMessage(error)}.${hint}`));
      });
      if (body) req.end(body);
      else if (file) fs.createReadStream(file).on("error", reject).pipe(req);
      else req.end();
    });
  }
}

function requireProject(project) {
  if (!project || typeof project !== "object" || !Array.isArray(project.clips) || !Array.isArray(project.media))
    throw new CliError("Project must be an object containing clips and media arrays");
  return project;
}

function validateDocument(project) {
  const mediaIds = new Set(project.media.filter((x) => x && typeof x === "object").map((x) => x.id));
  for (const clip of project.clips) {
    if (!clip || typeof clip !== "object") throw new CliError("Each clip must be an object");
    if (!clip.id || !clip.track || !Number.isFinite(clip.start) || !Number.isFinite(clip.duration))
      throw new CliError(`Clip ${clip.id || "(unknown)"} must have id, track, numeric start, and numeric duration`);
    if (!new Set(["text", "adjust"]).has(clip.kind) && !mediaIds.has(clip.mediaId))
      throw new CliError(`Clip ${clip.id} references unknown mediaId: ${clip.mediaId}`);
  }
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
async function putProject(client, id, project, force = false) {
  return client.request("PUT", "/api/project", { query: { project: id, force: force ? "1" : undefined }, json: project });
}
async function patchProject(client, id, ops) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    const updated = applyOps(await getProject(client, id), ops);
    try { await putProject(client, id, updated.project); return updated; }
    catch (error) { if (error.status !== 409) throw error; last = error; }
  }
  throw new CliError("Project kept changing; three conflict retries failed: " + last.message);
}

const DEFAULT_PROPS = { x:0,y:0,scale:1,rotation:0,opacity:1,volume:1,speed:1,blend:"normal",fit:"contain",cropL:0,cropR:0,cropT:0,cropB:0,cornerRadius:0,flipH:false,flipV:false,filterPreset:"none",brightness:100,contrast:100,saturation:100,hue:0,temperature:0,tint:0,blur:0,grayscale:0,sepia:0,invert:0,vignette:0,shake:0,shakeSpeed:8,rgbSplit:0,grain:0,chromaKey:"",chromaTolerance:26,chromaSoftness:12,bgRemove:false,text:"Title",fontSize:72,color:"#ffffff",color2:"",font:"Segoe UI",bold:true,weight:0,italic:false,uppercase:false,align:"center",letterSpacing:0,lineHeight:1.2,textShadow:12,glow:0,glowColor:"",strokeWidth:0,strokeColor:"#000",bgColor:"#000",bgOpacity:0,textAnim:"none",wordRate:0.15 };
function number(value) { return typeof value === "number" ? String(Math.round(value * 1000) / 1000) : String(value); }
function compactProject(id, project) {
  const duration = project.clips.reduce((max, clip) => Math.max(max, Number(clip.start || 0) + Number(clip.duration || 0)), 0);
  const lines = [`Project ${id} | ${project.name || ""} | ${project.width}x${project.height} @${project.fps}fps | ${number(duration)}s | revision ${project.revision || 0}`, `Media ${project.media.length} | Clips ${project.clips.length}`];
  for (const media of project.media) lines.push(`M ${media.id} ${media.kind} ${media.name || ""}${media.duration == null ? "" : " " + number(media.duration) + "s"}`);
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

function createAuthProxy(client) {
  const upstreams = new Set();
  const server = http.createServer((incoming, outgoing) => {
    const target = new URL(client.base.href);
    target.pathname = client.basePath + incoming.url.split("?")[0];
    target.search = incoming.url.includes("?") ? incoming.url.slice(incoming.url.indexOf("?")) : "";
    const headers = { ...incoming.headers, host: client.base.host };
    if (client.token) headers.authorization = "Bearer " + client.token;
    if (headers.origin) headers.origin = client.base.origin;
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(target, { method: incoming.method, headers }, (response) => {
      outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
    });
    upstreams.add(request);
    request.once("close", () => upstreams.delete(request));
    request.on("error", (error) => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(error.message); });
    incoming.pipe(request);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      port: server.address().port,
      close() {
        for (const request of upstreams) request.destroy();
        if (server.closeAllConnections) server.closeAllConnections();
        server.close();
        server.unref();
      },
    }));
  });
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
  const projectId = requireOption(options, "project");
  const project = await getProject(client, projectId);
  const ffmpeg = await client.request("GET", "/api/export/ffmpeg");
  if (!ffmpeg.available) throw new CliError("The FableCut server cannot find ffmpeg on PATH");
  const name = String(options.name || project.name || "export").replace(/[^\w\- ]+/g, "") || "export";
  const defaultFile = name.replace(/\s+/g, "-") + ".mp4";
  const output = path.resolve(String(options.output || defaultFile));
  const timeoutSeconds = Number(options.timeout || 3600);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new CliError("--timeout must be a positive number of seconds");
  if (fs.existsSync(output) && !options.force) throw new CliError(`Output already exists: ${output} (pass --force to replace it)`);
  const browserPath = findBrowser(options.browser === true ? undefined : options.browser);
  const requestId = require("crypto").randomBytes(16).toString("hex");
  const proxy = await createAuthProxy(client);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tik-editvideo-cli-chrome-"));
  const url = new URL(`http://127.0.0.1:${proxy.port}/`);
  url.searchParams.set("project", projectId);
  url.searchParams.set("cliExport", requestId);
  url.searchParams.set("cliExportName", name);
  const chrome = spawn(browserPath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--user-data-dir=" + profile, "--window-size=1440,1000", url.href], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  chrome.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const deadline = Date.now() + timeoutSeconds * 1000;
  let status;
  try {
    while (Date.now() < deadline) {
      await delay(500);
      try { status = await client.request("GET", "/api/export/status", { query: { project: projectId, id: requestId } }); }
      catch (error) { if (error.status !== 404) throw error; continue; }
      if (status.state === "complete") break;
      if (status.state === "error") throw new CliError("Export failed: " + status.error);
      if (chrome.exitCode !== null) throw new CliError(`Chrome exited before export completed${stderr ? ": " + stderr.trim().slice(-800) : ""}`);
    }
    if (!status || status.state !== "complete") throw new CliError(`Export timed out after ${timeoutSeconds} seconds`);
    await download(client, status.src, output, !!options.force);
    console.log(JSON.stringify({ ok: true, project: projectId, output, src: status.src }, null, 2));
  } finally {
    if (chrome.exitCode === null) chrome.kill();
    proxy.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function printHelp() {
  console.log(`tik-editvideo-cli - FableCut server, editing, and export CLI

Usage:
  tik-editvideo-cli server start [--host 127.0.0.1] [--port 7777] [--data-dir <dir>]
  tik-editvideo-cli list-projects
  tik-editvideo-cli create-project --name <name> [--id <id>]
  tik-editvideo-cli get-project --project <id> [--compact]
  tik-editvideo-cli patch-project --project <id> --ops '<JSON array>'
  tik-editvideo-cli set-project --project <id> --document '<JSON object>' [--force]
  tik-editvideo-cli import-media --project <id> --path <file>
  tik-editvideo-cli export --project <id> [--name <name>] [--output <mp4>] [--force]
                     [--browser <path>] [--timeout <seconds>]

Environment:
  FABLECUT_URL       Server URL (default http://127.0.0.1:7777)
  FABLECUT_TOKEN     Optional Bearer token for hosted servers
  FABLECUT_DATA_DIR  Project/library storage (default ~/.fablecut)
  CHROME_PATH        Chrome/Chromium executable used by 'export'`);
}

async function main(argv = process.argv.slice(2)) {
  const { positionals, options } = parseArgs(argv);
  const command = positionals[0];
  if (!command || command === "help" || options.help) { printHelp(); return; }
  if (command === "server") {
    if (positionals[1] !== "start") throw new CliError("Use: tik-editvideo-cli server start");
    if (options.host) process.env.HOST = String(options.host);
    if (options.port) process.env.PORT = String(options.port);
    if (options["data-dir"]) process.env.FABLECUT_DATA_DIR = path.resolve(String(options["data-dir"]));
    else if (!process.env.FABLECUT_DATA_DIR) process.env.FABLECUT_DATA_DIR = DEFAULT_DATA_DIR;
    require(path.join(runtimeDir(), "server.js"));
    return;
  }
  const client = new Client(options.url === true ? undefined : options.url);
  if (command === "list-projects") {
    console.log(JSON.stringify(await client.request("GET", "/api/projects"), null, 2));
  } else if (command === "create-project") {
    const json = { name: requireOption(options, "name") }; if (options.id && options.id !== true) json.id = String(options.id);
    console.log(JSON.stringify(await client.request("POST", "/api/projects", { json }), null, 2));
  } else if (command === "get-project") {
    const id = requireOption(options, "project"), project = await getProject(client, id);
    console.log(options.compact ? compactProject(id, project) : JSON.stringify(project, null, 2));
  } else if (command === "patch-project") {
    const id = requireOption(options, "project");
    const result = await patchProject(client, id, parseJSON(requireOption(options, "ops"), "--ops", "array"));
    console.log(JSON.stringify({ ok:true, project:id, revision:result.project.revision, clips:result.project.clips.length, media:result.project.media.length, changes:result.notes }, null, 2));
  } else if (command === "set-project") {
    const id = requireOption(options, "project");
    const project = clone(requireProject(parseJSON(requireOption(options, "document"), "--document", "object")));
    validateDocument(project); project.revision = Number(project.revision || 0) + 1;
    const response = await putProject(client, id, project, !!options.force);
    console.log(JSON.stringify({ ok:true, project:id, revision:project.revision, response }, null, 2));
  } else if (command === "import-media") {
    const id = requireOption(options, "project"), source = path.resolve(requireOption(options, "path"));
    if (!fs.statSync(source, { throwIfNoEntry:false })?.isFile()) throw new CliError("Media file not found: " + source);
    const kind = KIND_BY_EXT.get(path.extname(source).toLowerCase());
    if (!kind) throw new CliError("Unsupported media extension: " + (path.extname(source) || "(none)"));
    const uploaded = await client.request("POST", "/api/upload", { query:{ project:id, name:path.basename(source) }, file:source });
    if (!uploaded.src) throw new CliError("Upload response did not contain src");
    const media = { id:newId("m_"), name:decodeURIComponent(path.basename(uploaded.src)), kind, src:uploaded.src };
    let result;
    try { result = await patchProject(client, id, [{ op:"addMedia", media }]); }
    catch (error) { throw new CliError(`File uploaded to ${uploaded.src}, but registration failed: ${error.message}`); }
    console.log(JSON.stringify({ ok:true, project:id, revision:result.project.revision, media }, null, 2));
  } else if (command === "export") await exportProject(client, options);
  else throw new CliError("Unknown command: " + command + " (run tik-editvideo-cli --help)");
}

module.exports = { main, applyOps, compactProject, Client };
