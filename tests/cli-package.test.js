"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, ...options });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited ${code}\n${stdout}\n${stderr}`)));
  });
}

test("npm tarball ships transformed code and works without build dependencies", { timeout: 300000 }, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tik-package-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const packed = JSON.parse(await run(npm, ["pack", "--json", "--pack-destination", temp], { cwd: path.join(root, "cli") }))[0];
  const files = packed.files.map(file => file.path);
  assert.ok(files.includes("dist/bin/tik-video-editor-cli.js"));
  assert.ok(files.includes("dist/runtime/app.js"));
  assert.ok(files.includes("LICENSE"));
  assert.ok(files.includes("THIRD-PARTY-NOTICES.md"));
  assert.ok(files.includes("dist/runtime/LICENSE"));
  assert.ok(!files.some(file => /^(bin|lib|runtime|tests|node_modules)\//.test(file) || file.endsWith(".map")));
  await run(npm, ["install", "--prefix", temp, "--omit=dev", "--offline", "--no-audit", "--no-fund", path.join(temp, packed.filename)]);
  const installed = path.join(temp, "node_modules/tik-video-editor-cli");
  assert.ok(!fs.existsSync(path.join(installed, "node_modules")));
  const manifest = JSON.parse(fs.readFileSync(path.join(installed, "package.json"), "utf8"));
  assert.equal(manifest.license, "SEE LICENSE IN LICENSE");
  assert.equal(fs.readFileSync(path.join(installed, "LICENSE"), "utf8"), fs.readFileSync(path.join(root, "cli/LICENSE"), "utf8"));
  assert.equal(fs.readFileSync(path.join(installed, "dist/runtime/LICENSE"), "utf8"), fs.readFileSync(path.join(root, "LICENSE"), "utf8"));
  assert.equal(manifest.bin["tik-video-editor-cli"], "dist/bin/tik-video-editor-cli.js");
  assert.ok(!manifest.dependencies && !manifest.optionalDependencies);
  // npm rebuild can rerun prepare; it must not load missing devDependencies.
  await run(npm, ["rebuild", "--prefix", temp, "--offline", "--no-audit", "--no-fund"]);
  assert.match(fs.readFileSync(path.join(installed, manifest.bin["tik-video-editor-cli"]), "utf8"), /^#!\/usr\/bin\/env node\n/);
  const env = { ...process.env, FABLECUT_TEST_CLI_DIR: path.join(installed, "dist") };
  delete env.NODE_TEST_CONTEXT;
  const result = await run(process.execPath, ["--test", "tests/cli-local.test.js", "cli/tests/auth.test.js", "cli/tests/doctor-download-asr.test.js", "tests/export-browser.test.js", "tests/ui-language.test.js"], { env });
  assert.match(result, /# fail 0/);
  for (const line of result.slice(result.lastIndexOf("1..")).trim().split("\n")) t.diagnostic(line);
});
