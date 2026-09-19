"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { fixture } = require("./helpers/cli");

function json(result) { assert.equal(result.code, 0, result.stderr); return JSON.parse(result.stdout); }
async function port(t, handler = (_req, res) => { res.end("not fablecut"); }) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { server, port: server.address().port };
}

test("offline multi-project edits, concurrent patches, conflict protection and fixed home", async t => {
  const { run, home, dataDir } = fixture(t);
  const trap = await port(t, () => assert.fail("editing must not send HTTP requests"));
  const invoke = args => run(args, { PORT: String(trap.port) });
  const projects = await Promise.all([invoke(["create-project", "--name", "A", "--id", "a"]), invoke(["create-project", "--name", "B", "--id", "b"])]);
  assert.deepEqual(projects.map(json).map(p => p.id).sort(), ["a", "b"]);
  const initial = json(await invoke(["get-project", "--project", "a"]));
  const edits = Array.from({ length: 12 }, (_, i) => invoke(["patch-project", "--project", i % 2 ? "a" : "b", "--ops", JSON.stringify([{ op: "addClip", clip: { id: `c${i}`, kind: "text", track: "V1", start: i, duration: 1, props: { text: String(i) } } }])]));
  (await Promise.all(edits)).forEach(json);
  for (const [id, parity] of [["a", 1], ["b", 0]]) {
    const doc = json(await invoke(["get-project", "--project", id]));
    assert.equal(doc.clips.length, 6); assert.equal(doc.revision, 6);
    assert.ok(doc.clips.every(c => Number(c.id.slice(1)) % 2 === parity));
  }
  const stale = await invoke(["set-project", "--project", "a", "--document", JSON.stringify(initial)]);
  assert.notEqual(stale.code, 0); assert.match(stale.stderr, /CONFLICT/);
  assert.equal(json(await invoke(["set-project", "--project", "a", "--document", JSON.stringify(initial), "--force"])).revision, 7);
  assert.ok(!fs.existsSync(path.join(home, "ignored")));
  assert.ok(!fs.existsSync(path.join(dataDir, "server.log")));
  assert.notEqual((await run(["list-projects", "--data-dir", home])).code, 0);
  assert.notEqual((await run(["list-projects"], { FABLECUT_URL: "http://example.invalid" })).code, 0);
  assert.notEqual((await run(["get-project", "--project", "missing"])).code, 0);
  assert.notEqual((await run(["get-project", "--project", "../escape"])).code, 0);
  const duplicates = (await Promise.all([run(["create-project", "--name", "same"]), run(["create-project", "--name", "same"])] )).map(json);
  assert.equal(new Set(duplicates.map(p => p.id)).size, 2);
  const source = path.join(home, "素材 intro.svg"); fs.writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  const imported = (await Promise.all([run(["import-media", "--project", "b", "--path", source]), run(["import-media", "--project", "b", "--path", source])])).map(json);
  assert.equal(new Set(imported.map(p => p.media.src)).size, 2);
  assert.equal(json(await run(["get-project", "--project", "b"])).media.length, 2);
});

test("status starts one persistent server, verifies workspace, and refreshes browser clients", async t => {
  const { run, dataDir } = fixture(t);
  const spare = await port(t); const p = spare.port;
  await new Promise(resolve => spare.server.close(resolve));
  json(await run(["create-project", "--name", "Preview", "--id", "preview"]));
  const args = ["status", "--project", "preview", "--port", String(p)];
  const results = (await Promise.all([run(args), run(args), run(args)])).map(json);
  const status = results[0];
  t.after(async () => { try { process.kill(status.pid); } catch {} await new Promise(resolve => setTimeout(resolve, 200)); });
  assert.equal(new Set(results.map(r => r.pid)).size, 1);
  assert.equal(results.filter(r => r.started).length, 1);
  assert.equal(status.dataDir, fs.realpathSync(dataDir));
  assert.equal(json(await run(args)).started, false);
  const page = await fetch(status.projectUrl); assert.equal(page.status, 200); assert.match(await page.text(), /FableCut/);
  const base = status.url;
  const old = await (await fetch(base + "api/project?project=preview")).json();
  // Opening SSE installs the project's file watcher, as a browser tab does.
  const abort = new AbortController();
  const events = await fetch(base + "api/events?project=preview", { signal: abort.signal });
  if (events.status !== 200) { abort.abort(); assert.fail("SSE route missing"); }
  const reader = events.body.getReader();
  await reader.read();
  json(await run(["patch-project", "--project", "preview", "--ops", '[{"op":"setProject","set":{"name":"Changed"}}]']));
  const event = await Promise.race([reader.read(), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("No SSE refresh")), 3000); timer.unref(); })]);
  assert.match(new TextDecoder().decode(event.value), /data:/); abort.abort();
  const rejected = await fetch(base + "api/project?project=preview", { method: "PUT", body: JSON.stringify({ ...old, revision: 1 }) });
  assert.equal(rejected.status, 409);
  const latest = await (await fetch(base + "api/project?project=preview")).json();
  assert.equal(latest.name, "Changed");
  assert.notEqual((await run(["status", "--project", "missing", "--port", String(p)])).code, 0);
});

test("status rejects foreign services and another data directory", async t => {
  const { run } = fixture(t);
  const foreign = await port(t);
  const result = await run(["status", "--port", String(foreign.port)]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /incompatible service/);
  const other = await port(t, (_req, res) => res.end(JSON.stringify({ service: "fablecut", pid: process.pid, dataDir: "another-directory" })));
  const mismatch = await run(["status", "--port", String(other.port)]);
  assert.notEqual(mismatch.code, 0); assert.match(mismatch.stderr, /another data directory/);
});

test("legacy user storage migrates once and is not merged", async t => {
  const { run, home, dataDir } = fixture(t);
  const legacy = path.join(home, ".fablecut"); fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, "sentinel"), "keep");
  json(await run(["list-projects"]));
  assert.ok(!fs.existsSync(legacy)); assert.equal(fs.readFileSync(path.join(dataDir, "sentinel"), "utf8"), "keep");
  fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, "unmerged"), "keep");
  json(await run(["list-projects"]));
  assert.ok(!fs.existsSync(path.join(dataDir, "unmerged")));
});

test("MCP and CLI patches share the project transaction lock", async t => {
  const { spawn } = require("node:child_process");
  const { run, env, dataDir, home } = fixture(t);
  json(await run(["create-project", "--name", "Shared", "--id", "shared"]));
  const mcp = spawn(process.execPath, [path.resolve(__dirname, "../mcp-server.js")], { cwd: home, env: { ...env, FABLECUT_DATA_DIR: dataDir }, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => mcp.kill());
  let buffer = ""; const pending = new Map(); let seq = 0;
  mcp.stdout.on("data", data => {
    buffer += data;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const result = JSON.parse(line); pending.get(result.id)?.(result); pending.delete(result.id);
    }
  });
  const call = (name, args) => new Promise(resolve => {
    const id = ++seq; pending.set(id, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
  const changes = Array.from({ length: 10 }, (_, i) => {
    const ops = [{ op: "addClip", clip: { id: `shared${i}`, kind: "text", track: "V1", start: i, duration: 1 } }];
    return i % 2 ? run(["patch-project", "--project", "shared", "--ops", JSON.stringify(ops)]).then(json)
      : call("fablecut_patch_project", { projectId: "shared", ops }).then(result => { assert.ok(!result.error); assert.ok(!result.result.isError, JSON.stringify(result)); });
  });
  await Promise.all(changes);
  const doc = json(await run(["get-project", "--project", "shared"]));
  assert.equal(doc.clips.length, 10); assert.equal(doc.revision, 10);
});

test("export starts the server and renders a real MP4 with the browser compositor", { timeout: 150000 }, async t => {
  const { spawnSync } = require("node:child_process");
  const candidates = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "google-chrome", "chromium"].filter(Boolean);
  const browser = candidates.find(candidate => path.isAbsolute(candidate) ? fs.existsSync(candidate) : spawnSync(candidate, ["--version"]).status === 0);
  if (!browser || spawnSync("ffmpeg", ["-version"]).status !== 0 || spawnSync("ffprobe", ["-version"]).status !== 0) { t.skip("Requires Chrome/Chromium, ffmpeg and ffprobe"); return; }
  const { run, home, dataDir } = fixture(t);
  const spare = await port(t); const p = spare.port; await new Promise(resolve => spare.server.close(resolve));
  json(await run(["create-project", "--name", "Render", "--id", "render"]));
  json(await run(["patch-project", "--project", "render", "--ops", JSON.stringify([
    { op: "setProject", set: { width: 160, height: 90, fps: 10, background: "#ff0000" } },
    { op: "addClip", clip: { kind: "text", track: "V1", start: 0, duration: 1, props: { text: "Test", font: "Arial", fontSize: 24 } } },
  ])]));
  assert.ok(!fs.existsSync(path.join(dataDir, "server.log")));
  const output = path.join(home, "render.mp4");
  let result;
  try {
    result = await run(["export", "--project", "render", "--output", output, "--port", String(p), "--browser", browser, "--timeout", "60"]);
    if (result.code === 0) {
      const optimizedOutput = path.join(home, "optimized.mp4");
      const optimized = json(await run(["export", "--project", "render", "--engine", "optimized", "--output", optimizedOutput, "--port", String(p), "--browser", browser, "--timeout", "60"]));
      assert.equal(optimized.output, optimizedOutput); assert.equal(optimized.metrics.engine, "optimized"); assert.equal(optimized.metrics.frames, 10);
      const frames = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", optimizedOutput], { encoding: "utf8" }).stdout);
      assert.equal(Number(frames.streams[0].nb_frames), 10);
    }
  }
  finally {
    try { const status = await (await fetch(`http://127.0.0.1:${p}/api/status`)).json(); process.kill(status.pid); } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.equal(json(result).output, output);
  const info = JSON.parse(spawnSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", output], { encoding: "utf8" }).stdout);
  const video = info.streams.find(stream => stream.codec_type === "video");
  assert.equal(video.width, 160); assert.equal(video.height, 90); assert.equal(Number(video.nb_frames), 10);
  assert.ok(Number(info.format.duration) >= 1);
  const pixel = spawnSync("ffmpeg", ["-v", "error", "-i", output, "-vf", "crop=2:2:0:0,scale=1:1", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]).stdout;
  assert.ok(pixel[0] > 200 && pixel[1] < 40 && pixel[2] < 40, "export should contain the red project background");
});

test("export rejects an unknown engine before starting the server", async t => {
  const { run, dataDir } = fixture(t);
  const result = await run(["export", "--project", "missing", "--engine", "invalid"]);
  assert.notEqual(result.code, 0); assert.match(result.stderr, /--engine must be fast or optimized/);
  assert.ok(!fs.existsSync(path.join(dataDir, "server.log")));
});
