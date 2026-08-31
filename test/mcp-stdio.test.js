"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("stdio adapter exposes the same multi-project structured contract", { timeout: 5_000 }, async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-stdio-test-"));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../mcp-server.js")], {
    env: { ...process.env, FABLECUT_MCP_DATA_DIR: data, FABLECUT_LOCAL_USER_ID: "stdio-test" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => { child.kill("SIGKILL"); fs.rmSync(data, { recursive: true, force: true }); });
  let buffer = "", nextId = 1;
  const waiting = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = waiting.get(message.id);
      if (resolve) { waiting.delete(message.id); resolve(message); }
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++; waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.result.serverInfo.version, "2.0.0");
  const created = await request("tools/call", { name: "fablecut_create_project", arguments: { name: "stdio" } });
  const projectId = created.result.structuredContent.projectId;
  const project = await request("tools/call", { name: "fablecut_get_project", arguments: { projectId } });
  assert.equal(project.result.structuredContent.project.name, "stdio");
  child.stdin.end();
});
