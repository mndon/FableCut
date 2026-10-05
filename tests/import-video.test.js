"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { prepareVideo, classify, selectEncoder, inspect, command } = require(path.join(process.env.FABLECUT_TEST_CLI_DIR || path.resolve(__dirname, "../cli"), "lib/import-video"));
const { fixture } = require("./helpers/cli");
const available = ["ffmpeg", "ffprobe"].every(p => spawnSync(p, ["-version"]).status === 0);
function workspace(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "import-video-")); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function make(root, name, extra = [], audio = true) {
  const file = path.join(root, name);
  const args = ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=2"];
  if (audio) args.push("-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "aac");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", ...extra, file);
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return file;
}
async function prepared(source, root, options = {}) { const dir = fs.mkdtempSync(path.join(root, "stage-")); return prepareVideo(source, dir, { log() {}, ...options }); }
async function videoHash(file) { return (await command("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-c:v", "copy", "-f", "hash", "-"])).output; }
test("compliant import preserves exact bytes, including silent video", { skip: !available }, async t => {
  const root = workspace(t);
  for (const audio of [true, false]) {
    const file = make(root, `copy-${audio}.mp4`, [], audio), result = await prepared(file, root);
    assert.equal(result.method, "copy"); assert.deepEqual(fs.readFileSync(result.path), fs.readFileSync(file));
    assert.equal(result.probe.audio_codecs.length, audio ? 1 : 0);
  }
});
test("container remux and audio-only conversion retain compressed video", { skip: !available }, async t => {
  const root = workspace(t);
  for (const [name, extra, method] of [["source.mkv", [], "remux"], ["pcm.mov", ["-c:a", "pcm_s16le"], "audio"]]) {
    const file = make(root, name, extra), result = await prepared(file, root);
    assert.equal(result.method, method); assert.equal(await videoHash(file), await videoHash(result.path));
    assert.equal(result.probe.audio_codecs[0], "aac");
  }
});
test("alignment keeps video pixels and refuses ASR-bound origin changes", { skip: !available }, async t => {
  const root = workspace(t), input = make(root, "original.mp4"), shifted = path.join(root, "shifted.mp4");
  const remux = spawnSync("ffmpeg", ["-v", "error", "-copyts", "-itsoffset", "0.5", "-i", input, "-c", "copy", shifted], { encoding: "utf8" });
  assert.equal(remux.status, 0, remux.stderr);
  await assert.rejects(prepared(shifted, root, { existingAsr: true }), /Existing ASR/);
  const { run, home, dataDir } = fixture(t);
  const created = await run(["create-project", "--name", "origin protection"]);
  assert.equal(created.code, 0, created.stderr);
  const id = JSON.parse(created.stdout).project_id, transcript = path.join(home, "asr.json");
  fs.writeFileSync(transcript, JSON.stringify({rich_result:null, channel:[]}));
  for (const binding of [["--asr-local-path", transcript], ["--asr-url", "https://example.com/asr.json"]]) {
    const rejected = await run(["import-media", "--project-id", id, "--path", shifted, ...binding]);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /Existing ASR/);
  }
  const project = JSON.parse((await run(["get-project", "--project-id", id])).stdout);
  assert.equal(project.revision, 0); assert.deepEqual(project.media, []);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "projects", id, "media")), []);
  const result = await prepared(shifted, root);
  assert.equal(result.method, "align"); assert.equal(await videoHash(input), await videoHash(result.path));
  assert.ok(Math.abs(result.probe.video_start) <= 0.1);
  assert.ok(result.probe.audio_starts.every(s => Math.abs(s) <= 0.1));
});
test("unsupported codec transcodes without reducing size or frame rate", { skip: !available }, async t => {
  const root = workspace(t), file = make(root, "mpeg4.avi", ["-c:v", "mpeg4", "-q:v", "2"]);
  const result = await prepared(file, root, { platform: "unsupported" });
  assert.equal(result.method, "transcode"); assert.equal(result.probe.video_codec, "h264");
  assert.deepEqual([result.probe.width, result.probe.height], [160, 120]);
  const before = await inspect(file), after = await inspect(result.path);
  assert.equal(after.video.r_frame_rate, before.video.r_frame_rate);
  assert.ok(Math.abs(result.probe.duration - before.duration) < 0.1);
  const times = async f => JSON.parse((await command("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", f])).output).frames.map(f => Number(f.best_effort_timestamp_time));
  assert.deepEqual(await times(result.path), await times(file));
});
test("hardware is launch-tested in platform order with software fallback", async () => {
  const calls = [];
  const run = async (_p, args) => { calls.push(args[args.indexOf("-c:v") + 1]); throw new Error("No hardware"); };
  assert.equal(await selectEncoder(run, "win32"), "libx264");
  assert.deepEqual(calls, ["h264_nvenc", "h264_qsv", "h264_amf"]);
});
test("actual hardware failure retries software once", { skip: !available }, async t => {
  const root = workspace(t), file = make(root, "incompatible.avi", ["-c:v", "mpeg4"]), encoders = [];
  const run = async (program, args, settings) => {
    if (args.includes("h264_videotoolbox")) {
      if (args.includes("lavfi")) return { output: "", errors: "" };
      encoders.push("hardware"); throw new Error("hardware resolution unsupported");
    }
    if (args.includes("libx264")) encoders.push("software");
    return command(program, args, settings);
  };
  const result = await prepared(file, root, { platform: "darwin", run });
  assert.equal(result.encoder, "libx264"); assert.deepEqual(encoders, ["hardware", "software"]);
});
test("HDR requires real color conversion, SDR 10-bit requires pixel conversion", () => {
  const info = { video: { codec_name: "h264", pix_fmt: "yuv420p10le", color_transfer: "smpte2084" }, audio: [], start: 0 };
  assert.equal(classify(info, "hdr.mp4").hdr, true); assert.equal(classify(info, "hdr.mp4").transcode, true);
  info.video.color_transfer = "bt709"; assert.equal(classify(info, "sdr.mp4").hdr, false); assert.equal(classify(info, "sdr.mp4").transcode, true);
});
test("CLI failed import rolls back media and revision; valid imports return media without preparation", { skip: !available }, async t => {
  const root = workspace(t), { run, dataDir } = fixture(t);
  const json = r => { assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };
  const id = json(await run(["create-project", "--name", "Import"])).project_id;
  const broken = path.join(root, "broken.mp4"); fs.writeFileSync(broken, "broken");
  assert.notEqual((await run(["import-media", "--project-id", id, "--path", broken])).code, 0);
  const before = json(await run(["get-project", "--project-id", id])); assert.equal(before.revision, 0); assert.equal(before.media.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "projects", id, "media")), []);
  const source = make(root, "valid.mp4");
  const imports = await Promise.all([0, 1].map(() => run(["import-media", "--project-id", id, "--path", source])));
  const results = imports.map(json); assert.notEqual(results[0].media.src, results[1].media.src);
  for (const result of results) {
    assert.deepEqual(Object.keys(result).sort(), ["media", "ok", "project", "revision"]);
    assert.equal(Object.hasOwn(result.media, "preparation"), false);
    const file = path.join(dataDir, ...result.media.src.split("/").filter(Boolean).map(decodeURIComponent));
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(source));
    assert.deepEqual([result.media.width, result.media.height], [160, 120]);
  }
});
test("multiple audio tracks survive alignment and delayed speech keeps its onset", { skip: !available }, async t => {
  const root = workspace(t), source = path.join(root, "multi.mp4");
  const create = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=2",
    "-itsoffset", "0.3", "-f", "lavfi", "-i", "aevalsrc=if(between(t\\,0.7\\,1)\\,sin(2*PI*440*t)\\,0):s=48000:d=1.7",
    "-f", "lavfi", "-i", "sine=frequency=880:duration=2", "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "libx264", "-c:a", "aac", source], { encoding: "utf8" });
  assert.equal(create.status, 0, create.stderr);
  const result = await prepared(source, root);
  assert.equal(result.method, "align"); assert.equal(result.probe.audio_codecs.length, 2);
  assert.equal(await videoHash(source), await videoHash(result.path));
  const decoded = spawnSync("ffmpeg", ["-v", "error", "-i", result.path, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1024 * 1024 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  let onset = 0;
  while (onset * 2 < decoded.stdout.length && Math.abs(decoded.stdout.readInt16LE(onset * 2)) < 2000) onset++;
  assert.ok(Math.abs(onset / 48000 - 1) < 0.05, `speech onset ${onset / 48000}`);
});
test("real HDR pixels are tone-mapped and missing color conversion fails", { skip: !available }, async t => {
  const root = workspace(t), source = path.join(root, "hdr.mkv");
  const created = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=160x120:r=25:d=1",
    "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "pools=1:frame-threads=1:log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc", "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", source], { encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);
  assert.equal((await inspect(source)).video.color_transfer, "smpte2084");
  const filters = spawnSync("ffmpeg", ["-hide_banner", "-filters"], { encoding: "utf8" }).stdout;
  if (!/\bzscale\b/.test(filters)) {
    await assert.rejects(prepared(source, root), /zscale/);
    t.diagnostic("Installed ffmpeg lacks zscale; HDR detection and refusal verified, successful tone-map requires zscale");
    return;
  }
  const result = await prepared(source, root);
  const after = await inspect(result.path);
  assert.equal(after.video.pix_fmt, "yuv420p"); assert.equal(after.video.color_transfer, "bt709");
  assert.equal(after.video.color_primaries, "bt709"); assert.equal(after.video.color_space, "bt709");
  assert.deepEqual([after.video.width, after.video.height], [160, 120]);
  let attempts = 0;
  await assert.rejects(prepared(source, root, { run: async (program, args, settings) => {
    if (program === "ffmpeg" && args.includes("-vf")) { attempts++; throw new Error("No such filter: zscale"); }
    return command(program, args, settings);
  } }), /zscale/);
  assert.ok(attempts <= 2);
});
test("missing ffprobe refuses import without registering media", { skip: !available }, async t => {
  const root = workspace(t), source = make(root, "valid.mp4"), { run, dataDir } = fixture(t);
  const id = JSON.parse((await run(["create-project", "--name", "Missing probe"])).stdout).project_id;
  const result = await run(["import-media", "--project-id", id, "--path", source], { PATH: root });
  assert.notEqual(result.code, 0); assert.match(result.stderr, /ffprobe is required/);
  const project = JSON.parse((await run(["get-project", "--project-id", id])).stdout);
  assert.equal(project.revision, 0); assert.deepEqual(project.media, []);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, "projects", id, "media")), []);
});
test("rotated video keeps its display orientation through copy and transcode", { skip: !available }, async t => {
  const root = workspace(t);
  for (const incompatible of [false, true]) {
    const base = make(root, `base-${incompatible}.mp4`, incompatible ? ["-c:v", "mpeg4"] : [], false);
    const source = path.join(root, `rotated-${incompatible}.mp4`);
    const r = spawnSync("ffmpeg", ["-v", "error", "-display_rotation:v:0", "90", "-i", base, "-c", "copy", source], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const result = await prepared(source, root);
    assert.deepEqual([result.probe.width, result.probe.height], [120, 160]);
    if (!incompatible) { assert.equal(result.method, "copy"); assert.deepEqual(fs.readFileSync(source), fs.readFileSync(result.path)); }
    else { assert.equal(result.method, "transcode"); assert.deepEqual([result.probe.encoded_width, result.probe.encoded_height], [120, 160]); }
  }
});
