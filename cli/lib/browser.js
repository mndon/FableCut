"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { extractZip } = require("./browser-zip");

// Update deliberately with browser/export regression tests, never during export.
const VERSION = "153.0.8010.52";
const DOWNLOAD_BASE = "https://cdn.npmmirror.com/binaries/chrome-for-testing";
function platformKey(platform = process.platform, arch = process.arch) {
  return { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "linux-x64": "linux64",
    "linux-arm64": "linux-arm64", "win32-x64": "win64", "win32-ia32": "win32" }[`${platform}-${arch}`];
}
function executable(key) {
  return path.join("chrome-" + key, key.startsWith("mac-")
    ? "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
    : key.startsWith("win") ? "chrome.exe" : "chrome");
}
function usable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch { return false; }
}
function locate(candidate) {
  if (path.isAbsolute(candidate) || /[/\\]/.test(candidate)) return usable(path.resolve(candidate)) ? path.resolve(candidate) : null;
  // Search PATH directly: no dependency on which/where and no shell quoting.
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? ["", ".exe"] : [""]) {
      const file = path.resolve(dir, candidate + suffix);
      if (usable(file)) return file;
    }
  }
  return null;
}
function systemCandidates() {
  return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean)
      .map(dir => path.join(dir, "Google/Chrome/Application/chrome.exe")),
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];
}

async function downloadArchive(url, target, log) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15 * 60 * 1000);
  async function responseFor(address, redirects = 0) {
    const parsed = new URL(address);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("Browser downloads require an HTTPS URL without credentials");
    return new Promise((resolve, reject) => {
      const request = https.get(parsed, { signal: controller.signal, timeout: 30000 }, response => {
        response.on("error", reject);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          response.resume();
          if (!response.headers.location || redirects >= 5) return reject(new Error("Too many browser download redirects"));
          try { resolve(responseFor(new URL(response.headers.location, parsed), redirects + 1)); }
          catch (error) { reject(error); }
        } else if (response.statusCode !== 200) {
          response.resume(); reject(new Error(`Browser download returned HTTP ${response.statusCode}`));
        } else resolve(response);
      });
      request.on("timeout", () => request.destroy(new Error("Browser download timed out")));
      request.on("error", reject);
    });
  }
  try {
    const response = await responseFor(url);
    const expected = Number(response.headers["content-length"] || 0);
    let received = 0, last = Date.now();
    const progress = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > 512 * 1024 ** 2) return callback(new Error("Browser download exceeds 512 MiB"));
      if (Date.now() - last > 2000) {
        log(`Downloading browser: ${Math.round(received / 1024 ** 2)}${expected ? "/" + Math.round(expected / 1024 ** 2) : ""} MiB`);
        last = Date.now();
      }
      callback(null, chunk);
    } });
    await pipeline(response, progress, fs.createWriteStream(target, { flags: "wx" }), { signal: controller.signal });
    if (!received || (expected && received !== expected)) throw new Error("Incomplete browser download");
  } finally { clearTimeout(timer); controller.abort(); }
}

async function verifyBrowser(file) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "tik-browser-check-"));
  const token = require("crypto").randomBytes(16).toString("hex");
  let child, closed, timer, stderr = "", ready;
  const pageReady = new Promise(resolve => { ready = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === "/" + token) {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(`<script>fetch("/${token}/ready")</script>`);
    } else if (request.url === `/${token}/ready`) { response.end("ok"); ready(); }
    else { response.writeHead(404); response.end(); }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    // Exercise the same page/JS path as export. --version on Windows and
    // --dump-dom on some Chrome builds do not reliably print or exit.
    child = spawn(file, ["--headless=new", "--no-first-run", "--no-default-browser-check",
      ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
      "--user-data-dir=" + profile, `http://127.0.0.1:${server.address().port}/${token}`],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    closed = new Promise(resolve => child.once("close", resolve));
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-600); });
    await Promise.race([pageReady, new Promise((_, reject) => {
      child.once("error", reject);
      child.once("close", code => reject(new Error(`Chrome exited (${code})`)));
      timer = setTimeout(() => reject(new Error("Chrome startup timed out")), 30000);
    })]);
  } catch (error) {
    throw new Error(`Downloaded Chrome could not run: ${error.message}. Check OS compatibility and, on Linux, required system libraries. ${stderr}`);
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
      await closed; clearTimeout(killTimer);
    }
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function ensureBrowser(explicit, {
  cacheRoot = path.join(os.homedir(), ".tik-editvideo-cli", "browsers"),
  env = process.env, platform = process.platform, arch = process.arch,
  candidates = systemCandidates(), download = downloadArchive, verify = verifyBrowser,
  log = message => process.stderr.write(message + "\n"),
} = {}) {
  const selected = explicit || env.CHROME_PATH;
  if (selected) {
    const found = locate(selected);
    if (!found) throw new Error("Browser is not executable: " + selected + "; fix --browser / CHROME_PATH or unset it for automatic setup");
    return found;
  }
  const key = platformKey(platform, arch);
  const destination = key && path.join(cacheRoot, VERSION, key);
  const browser = key && path.join(destination, executable(key));
  const ready = () => {
    try { return usable(browser) && fs.readFileSync(path.join(destination, ".complete"), "utf8") === VERSION; }
    catch { return false; }
  };
  if (key && ready()) return browser;
  for (const candidate of candidates) { const found = locate(candidate); if (found) return found; }
  if (!key) throw new Error(`Automatic browser setup is unavailable on ${platform}/${arch}; pass --browser <path> or set CHROME_PATH`);
  const base = env.FABLECUT_BROWSER_DOWNLOAD_BASE_URL || DOWNLOAD_BASE;
  const url = `${base.replace(/\/+$/, "")}/${VERSION}/${key}/chrome-${key}.zip`;
  const parent = path.dirname(destination);
  await fs.promises.mkdir(parent, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(parent, ".install-"));
  try {
    log(`Preparing Chrome for Testing ${VERSION} (${key}); this download is cached for future exports.`);
    const archive = path.join(staging, "browser.zip"), unpacked = path.join(staging, "unpacked");
    await download(url, archive, log);
    await fs.promises.mkdir(unpacked);
    log("Extracting browser…");
    await extractZip(archive, unpacked);
    const installed = path.join(unpacked, executable(key));
    if (!usable(installed)) throw new Error("Browser archive is missing its executable");
    await verify(installed);
    await fs.promises.writeFile(path.join(unpacked, ".complete"), VERSION);
    // Publish only complete installations. A concurrent installer may win.
    if (!ready()) {
      try { await fs.promises.rename(unpacked, destination); }
      catch (error) {
        if (!ready()) throw new Error(`${error.message}; remove the incomplete cache at ${destination} and retry`);
      }
    }
    log("Browser ready.");
    return browser;
  } catch (error) {
    throw new Error(`Automatic browser setup failed: ${error.message}. Retry export, set FABLECUT_BROWSER_DOWNLOAD_BASE_URL to a trusted HTTPS mirror, or use --browser <path>.`);
  } finally { await fs.promises.rm(staging, { recursive: true, force: true }); }
}

module.exports = { ensureBrowser, downloadArchive, verifyBrowser, platformKey, executable, VERSION };
