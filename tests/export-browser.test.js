/* Opt-in real Chrome/ffmpeg integration. All work lives in an isolated data dir.
   FABLECUT_BROWSER_TEST=1 node --test tests/export-browser.test.js
   FABLECUT_EXPORT_BENCH=1 adds the 60s 1080p cold/warm performance benchmark. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { command } = require("../export-cache");
const enabled = process.env.FABLECUT_BROWSER_TEST === "1";
const benchmark = process.env.FABLECUT_EXPORT_BENCH === "1";
const browser = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const delay = ms => new Promise(r => setTimeout(r, ms));
async function stop(child) {
  if (child.exitCode !== null) return;
  const done = new Promise(r => child.once("close", r)); child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 2000); await done; clearTimeout(timer);
}
test("packaged runtime exports Fast and Optimized with matching frames", { skip: !enabled, timeout: 1800000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fablecut-browser-"));
  console.log("export test artifacts:", dir);
  const data = path.join(dir, "data"), projectDir = path.join(data, "projects", "check");
  await fs.mkdir(path.join(projectDir, "media"), { recursive: true });
  const duration = benchmark ? 60 : 6, width = benchmark ? 1920 : 640, height = benchmark ? 1080 : 360;
  const source = path.join(projectDir, "media", "source.mp4");
  await command("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=30:duration=${duration + 1}`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration + 1}`, "-c:v", "libx264", "-preset", "fast", "-g", "90", "-crf", "18", "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-c:a", "aac", "-movflags", "+faststart", source]);
  const project = { name: "Export verification", revision: 1, width, height, fps: 30, media: [{ id: "m", name: "source", kind: "video", duration: duration + 1, width, height, src: "/projects/check/media/source.mp4" }],
    clips: [{ id: "c", mediaId: "m", kind: "video", track: "V1", start: 0, in: 0.017, duration, props: {} },
      { id: "caption", kind: "text", track: "V2", start: 0, in: 0, duration, props: { text: "Optimized export verification", font: "Arial", fontSize: 32, y: height * 0.3, color: "#ffffff" } }] };
  await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify(project));
  const net = require("node:net");
  const reserve = net.createServer(); await new Promise(r => reserve.listen(0, "127.0.0.1", r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const running = spawn(process.execPath, [path.resolve(__dirname, "../cli/runtime/server.js")], { env: { ...process.env, FABLECUT_DATA_DIR: data, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => stop(running));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/api/status")).ok) break; } catch {} await delay(100); }
  const caps = await (await fetch(base + "/api/export/ffmpeg")).json(); assert.ok(caps.available && caps.ffprobe);
  const page = await (await fetch(base)).text(); for (const engine of ["engineFast", "engineRealtime", "engineOptimized"]) assert.ok(page.includes(engine));
  async function render(engine, run) {
    const id = require("node:crypto").randomBytes(16).toString("hex");
    const url = `${base}/?project=check&cliExport=${id}&cliExportEngine=${engine}&cliExportName=${engine}-${run}`;
    const keychainArgs = process.platform === "darwin" ? ["--use-mock-keychain"] : [];
    const child = spawn(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", ...keychainArgs, "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--user-data-dir=" + path.join(dir, "chrome-" + id), url], { stdio: ["ignore", "ignore", "pipe"] });
    const start = Date.now(); let stderr = "", status;
    child.stderr.on("data", d => { stderr = (stderr + d).slice(-1000); });
    try {
      while (Date.now() - start < 600000) {
        const response = await fetch(`${base}/api/export/status?project=check&id=${id}`); status = await response.json();
        if (status.state === "error") throw new Error(status.error);
        if (status.state === "complete") break;
        if (child.exitCode !== null) throw new Error(stderr);
        await delay(200);
      }
      assert.equal(status.state, "complete", JSON.stringify(status));
      const ms = Date.now() - start;
      console.log(engine, run, ms, JSON.stringify(status.metrics ? { phases: status.metrics.phases, cache: status.metrics.cache, fps: status.metrics.fps } : {}));
      const file = path.join(data, "projects", "check", "exports", decodeURIComponent(status.src.split("/").pop()));
      const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file]));
      const expectedFrames = Math.round(Math.max(...project.clips.map(c => c.start + c.duration)) * project.fps);
      assert.equal(Number(probe.streams[0].nb_frames), expectedFrames);
      assert.ok(Math.abs(Number(probe.streams[0].duration) - expectedFrames / project.fps) < 0.04);
      assert.ok(probe.streams.some(s => s.codec_type === "audio"));
      return { file, ms, metrics: status.metrics };
    } finally { await stop(child); }
  }
  const results = [];
  const runs = benchmark ? 3 : 1;
  for (let run = 0; run < runs; run++) {
    const fast = await render("fast", run);
    await fs.rm(path.join(projectDir, ".export-cache"), { recursive: true, force: true });
    const cold = await render("optimized", "cold-" + run), warm = await render("optimized", "warm-" + run);
    assert.equal(Object.keys(cold.metrics.cache.fallbacks).length, 0);
    assert.ok(warm.metrics.cache.hits > 0);
    assert.ok(cold.metrics.snapshotDepth >= 1 && cold.metrics.snapshotDepth <= 2);
    // Scheduling/cache state must not change a single decoded frame or sample.
    // This catches snapshot races that an aggregate SSIM score can conceal.
    const hashes = [];
    for (const output of [cold, warm]) {
      const video = await command("ffmpeg", ["-v", "error", "-i", output.file, "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "framemd5", "-"]);
      const audio = await command("ffmpeg", ["-v", "error", "-i", output.file, "-map", "0:a:0", "-c:a", "pcm_s16le", "-f", "hash", "-hash", "sha256", "-"]);
      hashes.push({ video, audio });
    }
    assert.deepEqual(hashes[0], hashes[1], "cold/warm exports must have identical frames and PCM audio");
    // Compare decoded export frames, not container bytes. PNG source decode can
    // differ slightly in color conversion; no timing/frame mismatch is acceptable.
    let quality = "";
    await command("ffmpeg", ["-hide_banner", "-i", fast.file, "-i", cold.file, "-lavfi", "[0:v][1:v]ssim", "-an", "-f", "null", "-"], undefined, s => { quality += s; });
    const score = Number(/All:([\d.]+)/.exec(quality)?.[1]); console.log("SSIM", score); assert.ok(score > 0.97, quality.slice(-500));
    results.push({ fast, cold, warm, ssim: score });
  }
  if (!benchmark) {
    // Exercise cached fixed speed, overlapping tracks, disabled media, SVG and
    // the browser-seek fallback within the same six-second composition.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="35" fill="#ffff00"/></svg>';
    await fs.writeFile(path.join(projectDir, "media", "overlay.svg"), svg);
    project.revision++;
    project.disabledTracks = ["V3"];
    project.media.push({ id: "svg", kind: "svg", name: "overlay", src: "/projects/check/media/overlay.svg" });
    project.clips[0].props = { speed: 0.5, filterPreset: "warm", volume: 0.3 };
    project.clips.push(
      { id: "pip", mediaId: "m", kind: "video", track: "V2", start: 1, in: 0.2, duration: 2, props: { speed: 2, scale: 0.4, x: 150, volume: 0 }, transitionIn: { type: "fade", duration: 0.5 } },
      { id: "ramp", mediaId: "m", kind: "video", track: "V2", start: 3, in: 1, duration: 2, props: { scale: 0.4, x: -150, volume: 0 }, keyframes: { speed: [{ t: 0, v: 1 }, { t: 2, v: 1.5 }] } },
      { id: "svg-overlay", mediaId: "svg", kind: "svg", track: "V2", start: 0, in: 0, duration, props: { scale: 0.2, x: -200 } },
      { id: "disabled", kind: "text", track: "V3", start: 0, duration, props: { text: "MUST NOT APPEAR", font: "Arial" } });
    await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify(project));
    const reference = await render("fast", "layers"), optimized = await render("optimized", "layers");
    assert.equal(optimized.metrics.cache.fallbacks.ramp, "speed ramp");
    let quality = "";
    await command("ffmpeg", ["-hide_banner", "-i", reference.file, "-i", optimized.file, "-lavfi", "[0:v][1:v]ssim", "-an", "-f", "null", "-"], undefined, s => { quality += s; });
    const ssim = Number(/All:([\d.]+)/.exec(quality)?.[1]); assert.ok(ssim > 0.97, quality.slice(-500));
    console.log("layered scene SSIM", ssim);
    // A fractional audio duration must not truncate the last B-frames during
    // stream-copy muxing. This composition rounds to 181 video frames.
    project.revision++;
    for (const c of project.clips) if (c.duration === duration) c.duration += 0.017;
    await fs.writeFile(path.join(projectDir, "project.json"), JSON.stringify(project));
    await render("optimized", "fractional-tail");
  }
  await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(results, null, 2));
  if (benchmark) {
    const median = k => results.map(r => r[k].ms).sort((a, b) => a - b)[1];
    const summary = { fastMs: median("fast"), coldMs: median("cold"), warmMs: median("warm") };
    summary.coldReduction = 1 - summary.coldMs / summary.fastMs; summary.warmReduction = 1 - summary.warmMs / summary.fastMs;
    console.log("BENCHMARK", JSON.stringify(summary));
    await fs.writeFile(path.join(dir, "benchmark.json"), JSON.stringify(summary, null, 2));
    assert.ok(summary.coldReduction >= 0.2, "cold export speed target"); assert.ok(summary.warmReduction >= 0.4, "warm export speed target");
  }
});
