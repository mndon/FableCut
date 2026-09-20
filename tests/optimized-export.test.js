"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ExportCache, frameIndex, localMedia, supported, validFrameTimes, command } = require("../export-cache");
const { OrderedFrameQueue, cachedFrameIndex, sourceReadAhead, SourceReadAhead, FrameReadAhead, SnapshotPipeline } = require("../optimized-export");
const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
async function fixture(t, limit, quantized = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fablecut-cache-test-"));
  const pp = { id: "test", dir, mediaDir: path.join(dir, "media"), projectFile: path.join(dir, "project.json") };
  await fs.mkdir(pp.mediaDir);
  const cache = new ExportCache({ libraryDir: pp.mediaDir, limit });
  t.after(async () => { cache.close(); await Promise.allSettled([...cache.jobs.values()].map(j => j.promise)); await fs.rm(dir, { recursive: true, force: true }); });
  const file = path.join(pp.mediaDir, "source.mp4");
  await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=30:duration=11", "-c:v", "libx264", "-g", "90", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", ...(quantized ? ["-video_track_timescale", "1000"] : []), file]);
  const project = { revision: 1, media: [{ id: "m", kind: "video", src: "/projects/test/media/source.mp4" }], clips: [{ id: "c", mediaId: "m", kind: "video", track: "V1", in: 0.017, duration: 10, props: {} }] };
  await fs.writeFile(pp.projectFile, JSON.stringify(project));
  const id = cache.create(pp, 1); await cache.get(id, pp.id).ready;
  return { cache, id, pp, project, file };
}
test("frame selection uses display intervals and subframe boundaries", () => {
  for (const select of [frameIndex, cachedFrameIndex]) {
    assert.equal(select([0, 1 / 30, 2 / 30], 0.02), 0);
    assert.equal(select([0, 1 / 30, 2 / 30], 1 / 30), 1);
    assert.equal(select([5, 5.033333], 4.99), -1);
    assert.equal(select([5, 5.033333], 5.034), 1);
  }
});
test("upload queue preserves order, bounds memory and propagates failures", async () => {
  const order = [];
  const q = new OrderedFrameQueue(async b => { await new Promise(r => setTimeout(r, 2)); order.push(b.n); }, 2, 10);
  for (let i = 0; i < 10; i++) await q.push({ size: 6, n: i });
  await q.finish(); assert.deepEqual(order, Array.from({ length: 10 }, (_, i) => i)); assert.ok(q.peakBytes <= 10);
  const broken = new OrderedFrameQueue(async () => { throw new Error("encoder failed"); });
  await broken.push({ size: 2 }); await assert.rejects(broken.finish(), /encoder failed/);
  await assert.rejects(broken.push({ size: 2 }), /encoder failed/);
  const cancelled = new OrderedFrameQueue(async () => {}); cancelled.cancel(); await assert.rejects(cancelled.push({ size: 2 }), /cancelled/);
});
test("metadata gate rejects HDR, variable rate and rotation", () => {
  const s = { r_frame_rate: "30/1", avg_frame_rate: "30/1", width: 160, height: 90, pix_fmt: "yuv420p", color_space: "bt709" };
  assert.ok(supported(s));
  for (const extra of [{ color_space: undefined }, { color_transfer: "smpte2084" }, { avg_frame_rate: "25/1" }, { sample_aspect_ratio: "2:1" }, { side_data_list: [{ rotation: 90 }] }]) assert.ok(!supported({ ...s, ...extra }));
});
test("native extraction, block boundary, cache hit, revision and project isolation", { skip: !ffmpeg }, async t => {
  const { cache, id, pp } = await fixture(t);
  assert.equal(cache.status(id, pp.id).state, "ready");
  assert.throws(() => cache.create(pp, 0), /Project changed/);
  assert.throws(() => cache.status(id, "another"), /no such/);
  await assert.rejects(cache.block(id, pp.id, "c", -1), /outside/);
  const [first, duplicate] = await Promise.all([cache.block(id, pp.id, "c", 0), cache.block(id, pp.id, "c", 0)]);
  assert.ok(!first.fallback, first.fallback); assert.equal(first.key, duplicate.key);
  assert.equal(first.times[0], 0); assert.ok(first.times.length >= 150);
  const second = await cache.block(id, pp.id, "c", 1);
  assert.ok(!second.fallback, second.fallback);
  assert.ok(second.times[0] < 5); assert.equal(second.times[frameIndex(second.times, 5)], 5);
  assert.ok((await fs.stat(cache.frame(id, pp.id, second.key, frameIndex(second.times, 5)))).size > 0);
  const hit = await cache.block(id, pp.id, "c", 1); assert.equal(hit.key, second.key); assert.ok(cache.status(id, pp.id).stats.hits > 0);
  assert.throws(() => cache.frame(id, pp.id, "../bad", 0), /unknown/);
  await assert.rejects(localMedia(pp, pp.mediaDir, "/projects/another/media/source.mp4"), /cross-project/);
  cache.release(id, pp.id); assert.equal(cache.pins.size, 0); assert.throws(() => cache.status(id, pp.id));
});
test("capacity overflow falls back without publishing partial frames", { skip: !ffmpeg }, async t => {
  const { cache, id, pp } = await fixture(t, 1);
  const result = await cache.block(id, pp.id, "c", 0);
  assert.match(result.fallback, /capacity/);
  assert.deepEqual(await fs.readdir(path.join(pp.dir, ".export-cache")), []);
});
test("changed sources and speed ramps use compatibility path", { skip: !ffmpeg }, async t => {
  const { cache, id, pp, project, file } = await fixture(t);
  await fs.utimes(file, new Date(), new Date(Date.now() + 10000));
  assert.match((await cache.block(id, pp.id, "c", 0)).fallback, /source changed/);
  project.clips[0].keyframes = { speed: [{ t: 0, v: 2 }] };
  await fs.writeFile(pp.projectFile, JSON.stringify(project));
  const next = cache.create(pp, 1); await cache.get(next, pp.id).ready;
  assert.equal(cache.status(next, pp.id).stats.fallbacks.c, "speed ramp");
});
test("cancel during extraction removes partials and permits retry", { skip: !ffmpeg }, async t => {
  const { cache, id, pp } = await fixture(t);
  const pending = cache.block(id, pp.id, "c", 0);
  while (!cache.jobs.size) await new Promise(r => setTimeout(r, 1));
  cache.release(id, pp.id);
  assert.match((await pending).fallback, /cancelled/);
  assert.equal(cache.pins.size, 0);
  assert.deepEqual(await fs.readdir(path.join(pp.dir, ".export-cache")), []);
  const next = cache.create(pp, 1); await cache.get(next, pp.id).ready;
  assert.ok(!(await cache.block(next, pp.id, "c", 0)).fallback);
});
test("LRU evicts only unleased blocks and supports content invalidation", { skip: !ffmpeg }, async t => {
  const { cache, id, pp, file } = await fixture(t);
  const first = await cache.block(id, pp.id, "c", 0); assert.ok(!first.fallback);
  cache.limit = first.bytes * 1.3;
  assert.match((await cache.block(id, pp.id, "c", 1)).fallback, /capacity/);
  cache.release(id, pp.id);
  const next = cache.create(pp, 1); await cache.get(next, pp.id).ready;
  const second = await cache.block(next, pp.id, "c", 1); assert.ok(!second.fallback, second.fallback);
  await assert.rejects(fs.stat(path.join(pp.dir, ".export-cache", first.key)), /ENOENT/);
  cache.drop(next, pp.id, ["c"]); assert.equal(cache.pins.size, 0);
  cache.release(next, pp.id);
  cache.limit = 2 * 1024 ** 3;
  // Change file content while preserving its registered media ID.
  await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=blue:size=160x90:rate=30:duration=11", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-colorspace", "bt709", file]);
  const changed = cache.create(pp, 1); await cache.get(changed, pp.id).ready;
  const replacement = await cache.block(changed, pp.id, "c", 1); assert.ok(!replacement.fallback); assert.notEqual(replacement.key, second.key);
});
test("two sessions share an extraction and retain separate leases", { skip: !ffmpeg }, async t => {
  const { cache, id, pp } = await fixture(t);
  const other = cache.create(pp, 1); await cache.get(other, pp.id).ready;
  const left = cache.block(id, pp.id, "c", 0), right = cache.block(other, pp.id, "c", 0);
  while (![...cache.pins.values()].some(n => n === 2)) await new Promise(r => setTimeout(r, 1));
  cache.release(id, pp.id);
  const result = await right; await left;
  assert.ok(!result.fallback, result.fallback);
  assert.ok((await fs.stat(cache.frame(other, pp.id, result.key, 0))).isFile());
  cache.release(other, pp.id); assert.equal(cache.pins.size, 0);
});
test("export dialog preserves original defaults and gates only the new engine on ffprobe", () => {
  const vm = require("node:vm"), source = require("node:fs").readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const code = source.slice(source.indexOf("function openExportSetup()"), source.indexOf("/* ── Fast export ── */"));
  const controls = new Map();
  const element = id => { if (!controls.has(id)) controls.set(id, { classList: { add() {}, remove() {} } }); return controls.get(id); };
  const sandbox = { state: { connected: true, ffmpeg: true, ffprobe: true }, project: { clips: [{}] }, TRACKS: [], $: element,
    els: { engineFast: element("fast"), engineRealtime: element("realtime"), exportSetup: element("setup") }, alert() {},
    optimizedExport() { sandbox.chosen = "optimized"; }, fastExport() { sandbox.chosen = "fast"; }, startExport() { sandbox.chosen = "realtime"; } };
  vm.createContext(sandbox); vm.runInContext(code, sandbox);
  sandbox.openExportSetup(); assert.equal(sandbox.els.engineFast.checked, true); assert.equal(element("engineOptimized").checked, false); assert.equal(element("engineOptimized").disabled, false);
  element("engineOptimized").checked = true; sandbox.startChosenExport(); assert.equal(sandbox.chosen, "optimized");
  sandbox.state.ffprobe = false; sandbox.openExportSetup(); assert.equal(sandbox.els.engineFast.disabled, false); assert.equal(element("engineOptimized").disabled, true);
  sandbox.state.ffmpeg = false; sandbox.openExportSetup(); assert.equal(sandbox.els.engineRealtime.checked, true); sandbox.startChosenExport(); assert.equal(sandbox.chosen, "realtime");
});
test("cached PNG pixels match the native source frame at fractional trims and block boundaries", { skip: !ffmpeg }, async t => {
  const { cache, id, pp, file } = await fixture(t);
  for (const time of [0.017, 4.999, 5, 5.017, 9.99]) {
    const block = await cache.block(id, pp.id, "c", Math.floor(time / 5)); assert.ok(!block.fallback, block.fallback);
    const index = frameIndex(block.times, time), frame = cache.frame(id, pp.id, block.key, index);
    const actual = spawnSync("ffmpeg", ["-v", "error", "-i", frame, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1024 ** 2 });
    const expected = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vf", `select=eq(n\\,${Math.floor(time * 30 + 1e-7)})`, "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1024 ** 2 });
    assert.equal(actual.status, 0); assert.equal(expected.status, 0);
    assert.equal(actual.stdout.length, 160 * 90 * 3);
    assert.ok(actual.stdout.equals(expected.stdout), `wrong source pixels at ${time}s`);
  }
});
test("optimized AI preparation supplies a canvas and does not resubmit during compositing", async () => {
  const vm = require("node:vm"), read = require("node:fs").readFileSync;
  const driver = read(path.join(__dirname, "../optimized-export.js"), "utf8"), app = read(path.join(__dirname, "../app.js"), "utf8");
  const maskCode = driver.slice(driver.indexOf("function optimizedMaskSource"), driver.indexOf("async function optimizedExport"));
  const prepCode = app.slice(app.indexOf("async function prepareFrameAssets"), app.indexOf("async function fastExport"));
  const bitmap = { width: 160, height: 90 };
  let drawn, submitted;
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: image => { drawn = image; } }) };
  const sandbox = { optimizedMaskCanvas: null, document: { createElement: () => canvas },
    optimizedSources: new Map([["c", bitmap]]), project: { clips: [{ id: "c", kind: "video", track: "V1", props: { bgRemove: true } }] },
    activeAt: () => true, isTrackEnabled: () => true, requestMask: async (_id, source, force) => { assert.equal(force, true); submitted = source; } };
  vm.createContext(sandbox); vm.runInContext(maskCode + prepCode, sandbox);
  await sandbox.prepareFrameAssets(0);
  assert.equal(drawn, bitmap); assert.equal(submitted, canvas); assert.equal(canvas.width, 160); assert.equal(canvas.height, 90);
  assert.match(app, /if \(p.bgRemove && c.kind === "video" && !optimizedSources\) requestMask/);
});

test("millisecond timestamp jitter retains native display intervals", { skip: !ffmpeg }, async t => {
  assert.ok(validFrameTimes([54, 54.033, 54.066, 54.099, 54.133, 54.166, 54.199, 54.233, 54.267, 54.299], 30));
  assert.ok(!validFrameTimes([0, 0.033, 0.033], 30));
  assert.ok(!validFrameTimes([0, 0.033, 0.1], 30));
  const { cache, id, pp } = await fixture(t, undefined, true);
  const block = await cache.block(id, pp.id, "c", 0);
  assert.ok(!block.fallback, block.fallback);
  assert.equal(block.times[1], 0.033); assert.equal(block.times[2], 0.067);
  assert.equal(frameIndex(block.times, 0.066), 1);
  assert.equal(Object.keys(cache.status(id, pp.id).stats.fallbacks).length, 0);
});
test("unsupported frame timing is rejected once per source, not once per cut", { skip: !ffmpeg }, async t => {
  const { cache, id, pp, project } = await fixture(t);
  cache.release(id, pp.id);
  project.clips.push({ ...project.clips[0], id: "next", in: 5 });
  await fs.writeFile(pp.projectFile, JSON.stringify(project));
  const session = cache.create(pp, 1); await cache.get(session, pp.id).ready;
  let attempts = 0;
  cache.build = async () => { attempts++; throw new Error("variable or invalid frame timestamps"); };
  assert.match((await cache.block(session, pp.id, "c", 0)).fallback, /invalid frame/);
  assert.match((await cache.block(session, pp.id, "next", 1)).fallback, /invalid frame/);
  assert.equal(attempts, 1);
});
test("read-ahead follows cuts and backwards source jumps, with bounded future clips", () => {
  const clips = [
    { id: "current", start: 0, in: 56.22, duration: 3.51, props: { speed: 1.1 } },
    { id: "near", start: 3.51, in: 60.08, duration: 2 },
    { id: "far", start: 5.51, in: 286.49, duration: 1 },
    { id: "backward", start: 6.51, in: 233.17, duration: 1 },
    { id: "later", start: 7.51, in: 350, duration: 1 },
  ];
  const plan = sourceReadAhead(clips, 0, 30);
  assert.deepEqual(plan.map(r => r.clip.id), ["current", "near", "far"]);
  assert.equal(Math.floor(plan[1].time / 5), 12);
  assert.equal(Math.floor(plan[2].time / 5), 57);
  const afterCut = sourceReadAhead(clips, 3.51, 30);
  assert.equal(Math.floor(afterCut.find(r => r.clip.id === "backward").time / 5), 46);
  // The first output sample after a fractional cut may be in the next block.
  const fractional = sourceReadAhead([{ id: "fractional", start: 1.001, in: 4.99, duration: 1 }], 0, 30);
  assert.equal(Math.floor(fractional[0].time / 5), 1);
});
test("speculative block preparation never blocks advancing the render timeline", async () => {
  const seen = new Set(), loaded = []; let finish;
  const scheduler = new SourceReadAhead(item => {
    loaded.push(item); seen.add(item);
    return new Promise(resolve => { finish = resolve; });
  }, item => seen.has(item));
  assert.equal(scheduler.update(["next", "obsolete"]), undefined);
  await Promise.resolve(); assert.deepEqual(loaded, ["next"]);
  scheduler.update(["next", "new-cut"]);
  finish(); await new Promise(r => setImmediate(r)); assert.deepEqual(loaded, ["next", "new-cut"]);
  const stopped = scheduler.stop(); finish(); await stopped;
  scheduler.update(["after-stop"]); await Promise.resolve(); assert.equal(loaded.length, 2);
});

test("frame read-ahead bounds concurrent decodes and replaces obsolete plans", async () => {
  const started = [], releases = new Map();
  const scheduler = new FrameReadAhead(item => {
    started.push(item.key);
    return new Promise(resolve => releases.set(item.key, resolve));
  });
  assert.equal(scheduler.update([1, 2, 3].map(key => ({ key }))), undefined);
  await Promise.resolve(); assert.deepEqual(started, [1, 2]);
  scheduler.update([2, 4, 5].map(key => ({ key })));
  releases.get(1)(); await new Promise(r => setImmediate(r));
  assert.deepEqual(started, [1, 2, 4]);
  const stopped = scheduler.stop();
  releases.get(2)(); releases.get(4)(); await stopped;
  scheduler.update([{ key: 6 }]); await Promise.resolve();
  assert.deepEqual(started, [1, 2, 4]);
});

test("snapshot pipeline overlaps encoding, bounds snapshots and writes in frame order", async () => {
  const captured = [], writes = [], complete = new Map();
  const pipeline = new SnapshotPipeline(async value => {
    captured.push(value);
    return { result: new Promise(resolve => complete.set(value, resolve)) };
  }, async value => writes.push(value));
  await pipeline.push(0); await pipeline.push(1);
  complete.get(1)(1);
  const next = pipeline.push(2);
  await Promise.resolve(); assert.deepEqual(captured, [0, 1]); assert.deepEqual(writes, []);
  complete.get(0)(0); await next;
  assert.deepEqual(captured, [0, 1, 2]);
  complete.get(2)(2); await pipeline.finish(); assert.deepEqual(writes, [0, 1, 2]);
  const broken = new SnapshotPipeline(async () => ({ result: Promise.reject(new Error("encode failed")) }), async () => {});
  await broken.push(0); await assert.rejects(broken.finish(), /encode failed/); await broken.settle();
});

test("worker failure encodes the original snapshot after the preview has advanced", async () => {
  const vm = require("node:vm"), source = require("node:fs").readFileSync(path.join(__dirname, "../optimized-export.js"), "utf8");
  let worker, closed = 0;
  const sandbox = { module: { exports: {} }, OffscreenCanvas: function () {},
    Worker: class { constructor() { worker = this; } postMessage(data) { this.job = data; } terminate() {} },
    createImageBitmap: async canvas => ({ width: 10, height: 10, value: canvas.value, close() { closed++; } }),
    document: { createElement: () => {
      const canvas = { getContext: () => ({ drawImage: bitmap => { canvas.value = bitmap.value; } }),
        toBlob: resolve => resolve({ size: 1, value: canvas.value }) };
      return canvas;
    } },
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const controller = new AbortController(), encoder = sandbox.module.exports.createSnapshotEncoder(controller.signal);
  const preview = { value: "frame 0" }, first = await encoder.capture(preview);
  preview.value = "frame 1";
  const second = await encoder.capture(preview); preview.value = "frame 2";
  worker.onmessage({ data: { id: worker.job.id, error: "worker failed" } });
  assert.equal((await first.result).value, "frame 0");
  assert.equal((await second.result).value, "frame 1"); assert.equal(closed, 2);
  encoder.close();
});

test("legacy Canvas encoding completes before the next snapshot can advance", async () => {
  const { createSnapshotEncoder } = require("../optimized-export");
  const controller = new AbortController(), encoder = createSnapshotEncoder(controller.signal);
  let complete, captured = false;
  const pending = encoder.capture({ toBlob(resolve) { complete = resolve; } }).then(job => { captured = true; return job; });
  await Promise.resolve(); assert.equal(captured, false);
  complete({ size: 1 }); assert.equal((await (await pending).result).size, 1);
  encoder.close();
});

test("snapshot cancellation rejects pending work and releases its bitmap", async () => {
  const vm = require("node:vm"), source = require("node:fs").readFileSync(path.join(__dirname, "../optimized-export.js"), "utf8");
  let created = 0, closed = 0, terminated = 0;
  const sandbox = { module: { exports: {} }, OffscreenCanvas: function () {},
    Worker: class { postMessage() {} terminate() { terminated++; } },
    createImageBitmap: async () => { created++; return { close() { closed++; } }; },
  };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const controller = new AbortController(), encoder = sandbox.module.exports.createSnapshotEncoder(controller.signal);
  const job = await encoder.capture({}); controller.abort();
  await assert.rejects(job.result, /stopped/); assert.equal(closed, created); assert.equal(terminated, 1);
});
test("growing extraction evicts unleased blocks before the disk budget fills", { skip: !ffmpeg }, async t => {
  const { cache, id, pp, file } = await fixture(t);
  cache.release(id, pp.id);
  await command("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30:duration=11", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-colorspace", "bt709", file]);
  const next = cache.create(pp, 1); await cache.get(next, pp.id).ready;
  const first = await cache.block(next, pp.id, "c", 0); assert.ok(!first.fallback, first.fallback);
  cache.drop(next, pp.id, ["c"]); cache.limit = Math.ceil(first.bytes * 1.5);
  const room = cache.room.bind(cache); let growthChecks = 0;
  cache.room = (root, required) => { if (required > 0) growthChecks++; return room(root, required); };
  const second = await cache.block(next, pp.id, "c", 1);
  assert.ok(growthChecks > 1, "test must exercise the in-flight space monitor");
  assert.ok(!second.fallback, second.fallback);
  await assert.rejects(fs.stat(path.join(pp.dir, ".export-cache", first.key)), /ENOENT/);
  assert.equal(Object.keys(cache.status(next, pp.id).stats.fallbacks).length, 0);
});
