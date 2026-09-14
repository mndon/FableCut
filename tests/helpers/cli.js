"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const cli = path.resolve(__dirname, "../../cli/bin/tik-editvideo-cli.js");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tik 测试 home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, FABLECUT_URL: "", FABLECUT_TOKEN: "", FABLECUT_DATA_DIR: path.join(home, "ignored"), HOST: "127.0.0.1", PORT: "7777" };
  const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, cwd: home });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
  return { home, env, run, dataDir: path.join(home, ".tik-editvideo-cli") };
}
module.exports = { fixture };
