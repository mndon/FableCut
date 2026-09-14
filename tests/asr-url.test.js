"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { applyOps, compactProject } = require("../cli/lib/cli");
const cli = path.resolve(__dirname, "../cli/bin/tik-editvideo-cli.js");
const asrUrl = "https://example.com/result.json?sig=a%2Bb&x=1";
const emptyProject = () => ({ name: "ASR test", revision: 1, width: 320, height: 180, fps: 24, media: [], clips: [] });

function run(args, url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, FABLECUT_URL: url, FABLECUT_TOKEN: "" },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => stdout += data);
    child.stderr.on("data", data => stderr += data);
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
  });
}

test("import stores ASR URL through conflict retry, project round trips and browser save", async t => {
  let project = emptyProject(), uploads = 0, conflicts = 1, requests = 0;
  const server = http.createServer(async (req, res) => {
    requests++;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/api/upload")) {
      uploads++; res.end(JSON.stringify({ src: "/projects/test/media/intro.mp4" }));
    } else if (req.method === "GET") res.end(JSON.stringify(project));
    else if (conflicts-- > 0) {
      project.name = "Concurrent edit"; project.revision++;
      res.statusCode = 409; res.end(JSON.stringify({ error: "stale revision" }));
    } else {
      project = JSON.parse(Buffer.concat(chunks)); res.end(JSON.stringify({ ok: true }));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fablecut-asr-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "intro.mp4");
  fs.writeFileSync(file, "synthetic upload fixture");

  for (const value of ["", "file:///tmp/a", "https:example.com/a", "/relative", "https://", "https://user:secret@example.com/a"]) {
    const result = await run(["import-media", "--project", "test", "--path", file, "--asr-url", value], url);
    assert.notEqual(result.code, 0);
  }
  assert.equal(requests, 0, "invalid URLs fail before uploading or reading the project");

  const imported = await run(["import-media", "--project", "test", "--path", file, "--asr-url", asrUrl], url);
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).media.asrUrl, asrUrl);
  assert.equal(uploads, 1);
  assert.equal(project.media.length, 1);
  assert.equal(project.media[0].asrUrl, asrUrl);
  assert.equal(project.name, "Concurrent edit");
  assert.match(compactProject("test", project), /asr=yes/);
  assert.ok(!compactProject("test", project).includes(asrUrl));

  const fetched = await run(["get-project", "--project", "test"], url);
  assert.equal(fetched.code, 0, fetched.stderr);
  const snapshot = JSON.parse(fetched.stdout);
  assert.equal(snapshot.media[0].asrUrl, asrUrl);
  snapshot.name = "Other device";
  const saved = await run(["set-project", "--project", "test", "--document", JSON.stringify(snapshot)], url);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(project.media[0].asrUrl, asrUrl);

  // Execute the browser's real normalizer and serializer without loading media or rendering.
  const source = fs.readFileSync(path.resolve(__dirname, "../app.js"), "utf8");
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const context = vm.createContext({ project, normalizeDisabledTracks: value => value || [] });
  vm.runInContext(section("function normalizeMediaEntry(m)", "function folderChildren(") +
    section("function projectJSON()", "function listenSSE()"), context);
  vm.runInContext("project.media = project.media.map(normalizeMediaEntry); project.name = 'Browser edit'", context);
  const browserSaved = JSON.parse(JSON.stringify(context.projectJSON()));
  assert.equal(browserSaved.media[0].asrUrl, asrUrl);
  assert.equal(browserSaved.name, "Browser edit");

  const legacy = await run(["import-media", "--project", "test", "--path", file], url);
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.ok(!("asrUrl" in JSON.parse(legacy.stdout).media));
});

test("addMedia and unrelated patches preserve URLs, legacy media remain unchanged", () => {
  const media = { id: "m1", name: "one.mp4", kind: "video", src: "https://example.com/one.mp4", asrUrl };
  const project = applyOps(emptyProject(), [{ op: "addMedia", media }]).project;
  const edited = applyOps(project, [{ op: "setProject", set: { name: "Renamed" } }]).project;
  assert.equal(edited.media[0].asrUrl, asrUrl);
  assert.equal(project.name, "ASR test", "patches do not mutate their input");
  for (const value of [null, true, "", "file:///tmp/a.json", "https:example.com/a"]) {
    assert.throws(() => applyOps(emptyProject(), [{ op: "addMedia", media: { ...media, asrUrl: value } }]), /asrUrl/);
  }
  const legacy = { ...media }; delete legacy.asrUrl;
  assert.ok(!("asrUrl" in applyOps(emptyProject(), [{ op: "addMedia", media: legacy }]).project.media[0]));
});
