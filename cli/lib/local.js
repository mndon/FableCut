"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

function initialize(runtime) {
  const dataDir = path.join(os.homedir(), ".tik-editvideo-cli");
  const legacy = path.join(os.homedir(), ".fablecut");
  // The CLI owns its storage location; inherited configuration cannot redirect it.
  process.env.FABLECUT_DATA_DIR = dataDir;
  const paths = require(path.join(runtime, "paths.js"));
  const store = require(path.join(runtime, "project-store.js"));
  store.withLock(path.join(os.homedir(), ".tik-editvideo-cli-initialize.lock"), () => {
    if (!fs.existsSync(dataDir) && fs.existsSync(legacy)) fs.renameSync(legacy, dataDir);
    paths.ensureDirs();
  });
  return { paths, store, dataDir: fs.realpathSync(dataDir), runtime };
}

function connection(options) {
  const host = String(options.host || process.env.HOST || "127.0.0.1").replace(/^\[(.*)\]$/, "$1");
  const port = Number(options.port || process.env.PORT || 7777);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer between 1 and 65535");
  if (!host || /[\s/?#]/.test(host)) throw new Error("Invalid --host");
  const address = host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;
  const url = `http://${address.includes(":") && !address.startsWith("[") ? `[${address}]` : address}:${port}`;
  return { host, port, url };
}
function probe(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url + "/api/status", { timeout: 1000 }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; if (body.length > 65536) req.destroy(new Error("Unexpected service response")); });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200 || data.service !== "fablecut" || !Number.isInteger(data.pid) || typeof data.dataDir !== "string") throw new Error();
          resolve(data);
        } catch { reject(new Error("Port is occupied by an incompatible service; choose another --port")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Service probe timed out; check the service or choose another --port")));
    req.on("error", error => error.code === "ECONNREFUSED" ? resolve(null) : reject(error));
  });
}
async function ensureServer(local, options) {
  const { host, port, url } = connection(options);
  if (options.project !== undefined) local.store.context(options.project);
  return local.store.withLock(path.join(local.dataDir, `.server-${port}.lock`), async () => {
    const check = async () => {
      const status = await probe(url);
      if (status && status.dataDir !== local.dataDir) throw new Error("Server uses another data directory; choose another --port");
      return status;
    };
    let status = await check(), started = false;
    if (!status) {
      const log = path.join(local.dataDir, "server.log");
      const fd = fs.openSync(log, "a");
      let child, launchError;
      try {
        child = spawn(process.execPath, [path.join(__dirname, "../bin/tik-editvideo-cli.js"), "server", "start", "--host", host, "--port", String(port)], {
          cwd: local.runtime, detached: true, windowsHide: true,
          stdio: ["ignore", fd, fd], env: { ...process.env },
        });
      } finally { fs.closeSync(fd); }
      child.on("error", error => { launchError = error; });
      child.unref();
      try {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          if (launchError) throw launchError;
          if (child.exitCode !== null) throw new Error(`Server exited (${child.exitCode}); see ${log}`);
          status = await check();
          if (status) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!status) throw new Error(`Server did not become ready; see ${log}`);
        started = status.pid === child.pid;
      } catch (error) { if (child.pid) child.kill(); throw error; }
    }
    const result = { ok: true, started, pid: status.pid, dataDir: local.dataDir, url: url + "/" };
    if (options.project !== undefined) {
      result.projectId = local.store.context(options.project).id;
      result.projectUrl = `${url}/?project=${encodeURIComponent(result.projectId)}`;
    }
    return result;
  });
}
module.exports = { initialize, ensureServer, connection };
