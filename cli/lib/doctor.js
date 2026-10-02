"use strict";
const { spawnSync } = require("child_process");

function doctor({ nodeVersion = process.versions.node, run = spawnSync } = {}) {
  const checks = { node: { ok: Number(nodeVersion.split(".")[0]) >= 18, version: nodeVersion } };
  if (!checks.node.ok) checks.node.error = "Node 18 or newer is required";
  for (const name of ["ffmpeg", "ffprobe"]) {
    const result = run(name, ["-version"], { encoding: "utf8", timeout: 10000, windowsHide: true, maxBuffer: 1024 * 1024 });
    checks[name] = result.status === 0
      ? { ok: true, version: String(result.stdout || "").split(/\r?\n/)[0] }
      : { ok: false, error: result.error?.code === "ENOENT" ? `${name} is not installed on PATH` : `${name} failed to execute${result.error?.code ? ": " + result.error.code : ""}` };
  }
  return { ok: Object.values(checks).every(check => check.ok), checks };
}
module.exports = { doctor };
