"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { FableCutCore, READ_SCOPE, WRITE_SCOPE } = require("../mcp/core");
const { McpProtocol } = require("../mcp/protocol");
const { ProjectStore, ownerKey } = require("../mcp/storage");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-core-test-"));
  const store = new ProjectStore(root);
  const core = new FableCutCore({ store, appDir: path.resolve(__dirname, "..") });
  const identity = (subject) => ({ issuer: "test", subject, ownerKey: ownerKey("test", subject),
    scopes: new Set([READ_SCOPE, WRITE_SCOPE]), local: false });
  return { root, store, core, a: identity("a"), b: identity("b") };
}

test("project tools require projectId while create and docs do not", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const projectTools = f.core.tools().filter((tool) => !["fablecut_create_project", "fablecut_docs"].includes(tool.name));
  assert.equal(projectTools.length, 6);
  for (const tool of projectTools) assert.ok(tool.inputSchema.required.includes("projectId"), tool.name);
  const docsTool = f.core.tools().find((tool) => tool.name === "fablecut_docs");
  assert.equal(docsTool.inputSchema.required.includes("projectId"), false);
  assert.equal(Object.hasOwn(docsTool.inputSchema.properties, "projectId"), false);
  const created = await f.core.call("fablecut_create_project", { name: "A" }, f.a);
  assert.match(created.projectId, /^[0-9a-f-]{36}$/);
  assert.equal(created.project.schemaVersion, 1);
  assert.equal(created.project.revision, 0);
});

test("projects are owner-private and persist", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const created = await f.core.call("fablecut_create_project", {}, f.a);
  assert.throws(() => f.store.read(created.projectId, f.b), (error) => error.code === "PROJECT_NOT_FOUND");
  const reopened = new ProjectStore(f.root).read(created.projectId, f.a);
  assert.deepEqual(reopened, created.project);
});

test("asset registration is idempotent", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { projectId } = await f.core.call("fablecut_create_project", {}, f.a);
  const args = { projectId, asset: { assetId: "asset-1", name: "clip.mp4", kind: "video", duration: 4 } };
  const first = await f.core.call("fablecut_import_media", args, f.a);
  const second = await f.core.call("fablecut_import_media", args, f.a);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.revision, first.revision);
  assert.equal(f.store.read(projectId, f.a).media.length, 1);
});

test("MCP project validation rejects persisted media URLs", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { projectId, project } = await f.core.call("fablecut_create_project", {}, f.a);
  project.media.push({ id: "m_bad", assetId: "asset-bad", name: "bad.mp4", kind: "video", src: "https://signed.example/secret" });
  await assert.rejects(f.core.call("fablecut_set_project", { projectId, project }, f.a),
    (error) => error.code === "INVALID_PROJECT" && /must not persist src/.test(error.message));
});

test("concurrent patches serialize without losing updates", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { projectId } = await f.core.call("fablecut_create_project", {}, f.a);
  await Promise.all([
    f.core.call("fablecut_patch_project", { projectId, ops: [{ op: "setProject", set: { background: "#111111" } }] }, f.a),
    f.core.call("fablecut_patch_project", { projectId, ops: [{ op: "setProject", set: { markers: [{ t: 1 }] } }] }, f.a),
  ]);
  const project = f.store.read(projectId, f.a);
  assert.equal(project.revision, 2);
  assert.equal(project.background, "#111111");
  assert.deepEqual(project.markers, [{ t: 1 }]);
});

test("same-base set allows one writer and conflicts the other", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const { projectId, project } = await f.core.call("fablecut_create_project", {}, f.a);
  const left = structuredClone(project); left.name = "left";
  const right = structuredClone(project); right.name = "right";
  const results = await Promise.allSettled([
    f.core.call("fablecut_set_project", { projectId, project: left }, f.a),
    f.core.call("fablecut_set_project", { projectId, project: right }, f.a),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  const rejected = results.find((item) => item.status === "rejected");
  assert.equal(rejected.reason.code, "CONFLICT");
  assert.equal(f.store.read(projectId, f.a).revision, 1);
});

test("protocol returns project JSON in structuredContent", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const protocol = new McpProtocol(f.core);
  const create = await protocol.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fablecut_create_project", arguments: {} } }, f.a);
  const projectId = create.result.structuredContent.projectId;
  const get = await protocol.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "fablecut_get_project", arguments: { projectId } } }, f.a);
  assert.equal(get.result.isError, false);
  assert.equal(get.result.structuredContent.project.schemaVersion, 1);
  assert.equal(typeof get.result.content[0].text, "string");
});

test("protocol enforces declared required parameters", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const protocol = new McpProtocol(f.core);
  const reply = await protocol.handle({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "fablecut_get_project", arguments: {} } }, f.a);
  assert.equal(reply.error.code, -32602);
  assert.match(reply.error.message, /projectId is required/);

  const docs = await protocol.handle({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "fablecut_docs", arguments: { section: "MCP connection" } } }, f.a);
  assert.equal(docs.result.isError, false);
  assert.equal(docs.result.structuredContent.projectId, undefined);
  assert.match(docs.result.structuredContent.markdown, /## MCP connection/);

  const legacyDocs = await protocol.handle({ jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "fablecut_docs", arguments: { projectId: "00000000-0000-0000-0000-000000000000" } } }, f.a);
  assert.equal(legacyDocs.error.code, -32602);
  assert.match(legacyDocs.error.message, /projectId is not allowed/);
});

test("reference analysis stores no download URL and reuses the original asset for music", async (t) => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const core = new FableCutCore({ store: f.store, appDir: path.resolve(__dirname, ".."),
    downloadFn: async (_url, file) => fs.writeFileSync(file, "fixture"),
    analyzeFn: async (_file, options) => ({ source: options.srcUrl, hasAudio: true, cuts: [1], beats: [0.5] }),
  });
  const { projectId } = await core.call("fablecut_create_project", {}, f.a);
  const imported = await core.call("fablecut_import_media", { projectId,
    asset: { assetId: "reference-1", name: "reference.mp4", kind: "video" } }, f.a);
  const downloadUrl = "https://assets.example.test/signed?secret=do-not-store";
  const result = await core.call("fablecut_analyze_reference", { projectId, assetId: "reference-1", downloadUrl }, f.a);
  assert.deepEqual(result.blueprint.music, { assetId: "reference-1", mediaId: imported.media.id });
  assert.equal(result.blueprint.source, "asset:reference-1");
  const jsonFiles = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file); else if (entry.name.endsWith(".json")) jsonFiles.push(file);
  });
  walk(f.root);
  const persisted = jsonFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(persisted.includes(downloadUrl), false);
});
