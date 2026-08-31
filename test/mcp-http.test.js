"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("Streamable HTTP serves a shared project namespace without authentication", async (t) => {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-http-test-"));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../mcp-http-server.js")], {
    env: { ...process.env, FABLECUT_MCP_HOST: "127.0.0.1", FABLECUT_MCP_PORT: String(port),
      FABLECUT_MCP_PUBLIC_URL: `http://127.0.0.1:${port}`, FABLECUT_MCP_DATA_DIR: data },
    stdio: ["ignore", "ignore", "pipe"],
  });
  t.after(() => { child.kill("SIGKILL"); fs.rmSync(data, { recursive: true, force: true }); });
  let startup = ""; child.stderr.on("data", (chunk) => { startup += chunk; });
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(startup, /FableCut MCP listening/);

  const call = async (message) => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
    }, body: JSON.stringify(message) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const created = await call({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fablecut_create_project", arguments: {} } });
  const projectId = created.result.structuredContent.projectId;
  const fetched = await call({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "fablecut_get_project", arguments: { projectId } } });
  assert.equal(fetched.result.isError, false);
  assert.equal(fetched.result.structuredContent.projectId, projectId);

  const listed = await call({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  assert.equal(listed.result.tools.some((tool) => tool.name === "fablecut_analyze_reference"), false);
  assert.equal(listed.result.tools.some((tool) => tool.name === "fablecut_status"), false);
  const importTool = listed.result.tools.find((tool) => tool.name === "fablecut_import_media");
  const assetSchema = importTool.inputSchema.properties.asset;
  assert.deepEqual(assetSchema.required, ["src", "name", "kind"]);
  assert.equal(Object.hasOwn(assetSchema.properties, "assetId"), false);

  const imported = await call({ jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "fablecut_import_media", arguments: { projectId,
      asset: { src: "https://cdn.example.test/clip.mp4", name: "clip.mp4", kind: "video", duration: 4 } } } });
  assert.equal(imported.result.isError, false);
  assert.equal(imported.result.structuredContent.media.src, "https://cdn.example.test/clip.mp4");
  assert.equal(Object.hasOwn(imported.result.structuredContent.media, "assetId"), false);
  const importedAgain = await call({ jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "fablecut_import_media", arguments: { projectId,
      asset: { src: "https://cdn.example.test/clip.mp4", name: "renamed.mp4", kind: "video" } } } });
  assert.equal(importedAgain.result.structuredContent.created, false);
  assert.equal(importedAgain.result.structuredContent.revision, imported.result.structuredContent.revision);
  const withMedia = await call({ jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "fablecut_get_project", arguments: { projectId } } });
  assert.equal(withMedia.result.structuredContent.project.media[0].src, "https://cdn.example.test/clip.mp4");

  const analyze = await call({ jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "fablecut_analyze_reference", arguments: {} } });
  assert.equal(analyze.error.code, -32602);
  assert.match(analyze.error.message, /Unknown tool/);

  const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource`);
  assert.equal(metadata.status, 404);
});
