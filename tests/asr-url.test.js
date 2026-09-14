"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { applyOps, compactProject } = require("../cli/lib/cli");
const asrUrl = "https://example.com/result.json?sig=a%2Bb&x=1";
const emptyProject = () => ({ name: "ASR test", revision: 1, width: 320, height: 180, fps: 24, media: [], clips: [] });

const { fixture } = require("./helpers/cli");

test("local import preserves ASR URL through project round trips and browser save", async t => {
  const { home, dataDir, run } = fixture(t);
  assert.equal((await run(["create-project", "--name", "ASR test", "--id", "test"])).code, 0);
  const file = path.join(home, "intro.mp4");
  fs.writeFileSync(file, "synthetic import fixture");

  for (const value of ["", "file:///tmp/a", "https:example.com/a", "/relative", "https://", "https://user:secret@example.com/a"]) {
    const result = await run(["import-media", "--project", "test", "--path", file, "--asr-url", value]);
    assert.notEqual(result.code, 0);
  }
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "projects/test/media")), []);

  const imported = await run(["import-media", "--project", "test", "--path", file, "--asr-url", asrUrl]);
  assert.equal(imported.code, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).media.asrUrl, asrUrl);
  const project = JSON.parse((await run(["get-project", "--project", "test"])).stdout);
  assert.equal(project.media.length, 1);
  assert.equal(project.media[0].asrUrl, asrUrl);
  assert.equal(project.name, "ASR test");
  assert.match(compactProject("test", project), /asr=yes/);
  assert.ok(!compactProject("test", project).includes(asrUrl));

  const fetched = await run(["get-project", "--project", "test"]);
  assert.equal(fetched.code, 0, fetched.stderr);
  const snapshot = JSON.parse(fetched.stdout);
  assert.equal(snapshot.media[0].asrUrl, asrUrl);
  snapshot.name = "Other device";
  const saved = await run(["set-project", "--project", "test", "--document", JSON.stringify(snapshot)]);
  assert.equal(saved.code, 0, saved.stderr);
  assert.equal(JSON.parse((await run(["get-project", "--project", "test"])).stdout).media[0].asrUrl, asrUrl);

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

  const legacy = await run(["import-media", "--project", "test", "--path", file]);
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
