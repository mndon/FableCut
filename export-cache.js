/* Optimized export source frames. Node standard library + ffmpeg/ffprobe only. */
"use strict";
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const os = require("node:os");
const PNG_THREADS = Math.min(2, os.availableParallelism?.() || os.cpus().length || 1);
const VERSION = 2, BLOCK_SECONDS = 5, LIMIT = 2 * 1024 ** 3;
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const rational = value => { const [a, b = 1] = String(value).split("/").map(Number); return a / b; };
function frameIndex(times, time) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= time + 1e-5) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
function command(cmd, args, signal, onErrorOutput) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", failure;
    const abort = () => { failure = new Error("cancelled"); child.kill("SIGKILL"); };
    const timer = setTimeout(() => { failure = new Error(cmd + " timed out"); child.kill("SIGKILL"); }, 120000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", d => { out += d; if (out.length > 16 * 1024 ** 2) { failure = new Error("probe output too large"); child.kill("SIGKILL"); } });
    child.stderr.on("data", d => { onErrorOutput?.(String(d)); err = (err + d).slice(-4000); });
    child.on("error", e => { failure = e; });
    child.on("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      failure || code !== 0 ? reject(failure || new Error(err || cmd + " failed")) : resolve(out);
    });
  });
}
function supported(stream) {
  const fps = rational(stream.r_frame_rate), avg = rational(stream.avg_frame_rate);
  return Number.isFinite(fps) && fps > 0 && fps <= 120 && Math.abs(fps - avg) < 1e-4 &&
    Number(stream.start_time || 0) === 0 && ["1:1", "0:1", undefined].includes(stream.sample_aspect_ratio) &&
    !stream.tags?.rotate && !stream.side_data_list?.some(s => s.rotation) &&
    ["yuv420p", "yuvj420p"].includes(stream.pix_fmt) &&
    ["bt709", "smpte170m", "bt470bg"].includes(stream.color_space) &&
    [undefined, "unknown", "bt709", "smpte170m", "bt470bg"].includes(stream.color_primaries) &&
    [undefined, "unknown", "bt709", "smpte170m", "gamma22", "gamma28"].includes(stream.color_transfer) &&
    stream.width > 0 && stream.height > 0;
}
function validFrameTimes(times, fps) {
  // Encoders often quantize nominal 30fps PTS to milliseconds (33/34ms).
  // Keep those native timestamps: rounding to an ideal CFR grid would choose
  // the wrong frame at cuts. Reject duplicates, gaps and substantial VFR.
  const step = 1 / fps, tolerance = Math.max(0.002, step * 0.1);
  return times.length > 0 && times.every((t, i) => Number.isFinite(t) &&
    (!i || (t > times[i - 1] && Math.abs(t - times[i - 1] - step) <= tolerance)));
}
async function localMedia(pp, libraryDir, src) {
  const prefix = `/projects/${pp.id}/media/`;
  let root, relative;
  if (src?.startsWith(prefix)) { root = pp.mediaDir; relative = src.slice(prefix.length); }
  else if (pp.id === "default" && src?.startsWith("/media/")) { root = pp.mediaDir; relative = src.slice(7); }
  else if (src?.startsWith("/library/")) { root = libraryDir; relative = src.slice(9); }
  else throw new Error("non-local or cross-project source");
  root = await fsp.realpath(root);
  const file = await fsp.realpath(path.resolve(root, decodeURIComponent(relative)));
  if (!file.startsWith(root + path.sep)) throw new Error("source escapes media directory");
  return file;
}
// One decoder at a time, with demand reads ahead of queued look-ahead work.
// Promotion changes a queued job in place; running extraction is never killed.
class ExtractionQueue {
  constructor() { this.pending = []; this.active = false; }
  enqueue(run, priority, neededAt, signal) {
    let resolve, reject;
    const job = { run, priority, neededAt, signal, promise: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
    const abort = () => {
      const index = this.pending.indexOf(job);
      if (index >= 0) { this.pending.splice(index, 1); reject(new Error("cancelled")); }
    };
    job.cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    this.pending.push(job);
    queueMicrotask(() => this.pump());
    return job;
  }
  promote(job, priority, neededAt) {
    if (priority === "demand") job.priority = "demand";
    job.neededAt = Math.min(job.neededAt, neededAt);
  }
  pump() {
    if (this.active) return;
    this.pending.sort((a, b) => (a.priority === "demand" ? 0 : 1) - (b.priority === "demand" ? 0 : 1) || a.neededAt - b.neededAt);
    const job = this.pending.shift();
    if (!job) return;
    job.cleanup(); this.active = true;
    Promise.resolve().then(() => {
      if (job.signal.aborted) throw new Error("cancelled");
      return job.run();
    }).then(job.resolve, job.reject).finally(() => { this.active = false; this.pump(); });
  }
}
class ExportCache {
  constructor({ libraryDir, limit = LIMIT, ttl = 90000 } = {}) {
    this.libraryDir = libraryDir; this.limit = limit; this.ttl = ttl;
    this.queue = new ExtractionQueue();
    this.sessions = new Map(); this.jobs = new Map(); this.pins = new Map(); this.roots = new Set();
    this.timer = setInterval(() => {
      for (const s of this.sessions.values()) if (Date.now() - s.touched > ttl) this.release(s.id, s.pp.id);
    }, Math.min(ttl, 15000));
    this.timer.unref();
  }
  get(id, projectId) {
    const s = this.sessions.get(id);
    if (!s || s.pp.id !== projectId) throw new Error("no such cache session");
    s.touched = Date.now(); return s;
  }
  create(pp, revision) {
    const project = JSON.parse(fs.readFileSync(pp.projectFile, "utf8").replace(/^\uFEFF/, ""));
    if (project.revision !== revision) throw new Error("Project changed; save/reload before exporting");
    const s = { id: crypto.randomBytes(16).toString("hex"), pp, project, touched: Date.now(),
      controller: new AbortController(), sources: new Map(), blocks: new Map(), leases: new Map(), pins: new Set(),
      state: "preparing", stats: { hits: 0, misses: 0, fallbacks: {}, extractionMs: 0, peakDiskBytes: 0 } };
    this.sessions.set(s.id, s);
    s.ready = this.prepare(s).then(() => { s.state = "ready"; }).catch(e => { s.state = "error"; s.error = e.message; });
    return s.id;
  }
  async prepare(s) {
    const disabled = new Set(s.project.disabledTracks || []), seen = new Map();
    for (const c of s.project.clips) {
      if (c.kind !== "video" || disabled.has(c.track)) continue;
      if (s.controller.signal.aborted) throw new Error("cancelled");
      try {
        if (c.keyframes?.speed?.length) throw new Error("speed ramp");
        const speed = Math.max(0.1, Math.min(8, (Number(c.props?.speed) || 1)));
        if (![c.in, c.duration, speed].every(Number.isFinite) || c.in < 0 || c.duration <= 0) throw new Error("invalid source interval");
        const media = s.project.media.find(m => m.id === c.mediaId);
        if (!seen.has(c.mediaId)) seen.set(c.mediaId, (async () => {
          const file = await localMedia(s.pp, this.libraryDir, media?.src);
          const stat = await fsp.stat(file);
          const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", file], s.controller.signal));
          const stream = probe.streams?.[0];
          if (!stream || !supported(stream)) throw new Error("unsupported/uncertain video metadata");
          const digest = crypto.createHash("sha256");
          for await (const chunk of fs.createReadStream(file)) {
            if (s.controller.signal.aborted) throw new Error("cancelled");
            digest.update(chunk);
          }
          return { file, stamp: `${stat.size}:${stat.mtimeMs}`, hash: digest.digest("hex"), fps: rational(stream.r_frame_rate),
            width: stream.width, height: stream.height, duration: Number(stream.duration) };
        })());
        const source = await seen.get(c.mediaId);
        s.sources.set(c.id, { ...source, start: c.in, end: c.in + c.duration * speed });
      } catch (e) { s.stats.fallbacks[c.id] = e.message; }
    }
  }
  status(id, projectId) {
    const s = this.get(id, projectId);
    return { id, state: s.state, error: s.error, clips: [...s.sources.keys()], stats: s.stats };
  }
  pin(s, dir) {
    if (s.pins.has(dir)) return;
    s.pins.add(dir); this.pins.set(dir, (this.pins.get(dir) || 0) + 1);
  }
  unpin(s, dir) {
    if (!s.pins.delete(dir)) return;
    const n = (this.pins.get(dir) || 1) - 1;
    if (n) this.pins.set(dir, n); else this.pins.delete(dir);
  }
  async room(root, required) {
    const entries = [];
    for (const name of await fsp.readdir(root)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const dir = path.join(root, name);
      try { const m = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"))); entries.push({ dir, bytes: m.bytes, time: (await fsp.stat(dir)).mtimeMs }); } catch {}
    }
    let bytes = entries.reduce((n, e) => n + e.bytes, 0);
    for (const e of entries.sort((a, b) => a.time - b.time)) {
      if (bytes + required <= this.limit) break;
      if (this.pins.has(e.dir) || this.jobs.has(e.dir)) continue;
      await fsp.rm(e.dir, { recursive: true, force: true }); bytes -= e.bytes;
    }
    if (bytes + required > this.limit) throw new Error("frame cache capacity exceeded");
    return bytes;
  }
  async build(root, dir, source, block, signal) {
    const partial = dir + ".partial-" + crypto.randomBytes(6).toString("hex");
    await fsp.mkdir(partial, { recursive: true });
    const times = []; let line = "";
    const begin = Math.max(0, block * BLOCK_SECONDS - 2 / source.fps);
    const end = (block + 1) * BLOCK_SECONDS + 1 / source.fps;
    // Input seek preserves original timestamps. Two nominal frames of overlap
    // retain the predecessor even when millisecond PTS jitter crosses a block
    // boundary; a single ideal-CFR interval is not always wide enough.
    const args = ["-hide_banner", "-loglevel", "info", "-nostdin", "-y", "-copyts", "-ss", String(Math.max(0, begin - 2)), "-t", String(end - Math.max(0, begin - 2) + 1), "-i", source.file,
      "-map", "0:v:0", "-an",
      "-vf", `select='gte(t,${begin - 1e-5})*lt(t,${end})',showinfo`, "-vsync", "0", "-threads", String(PNG_THREADS), "-compression_level", "1", path.join(partial, "%06d.png")];
    let monitor, monitorTask = Promise.resolve(), checkingSpace = false, overLimit = false;
    const local = new AbortController();
    const abort = () => local.abort(); signal.addEventListener("abort", abort, { once: true });
    try {
      await this.room(root, 0);
      monitor = setInterval(() => {
        if (checkingSpace) return;
        checkingSpace = true;
        monitorTask = (async () => {
          const files = await fsp.readdir(partial);
          const sizes = await Promise.all(files.map(file => fsp.stat(path.join(partial, file))));
          // Make room while the partial grows. Comparing against an initial
          // free-space snapshot falsely rejects new blocks near the limit,
          // even when completed earlier clips have released evictable blocks.
          await this.room(root, sizes.reduce((bytes, stat) => bytes + stat.size, 0));
        })().catch(() => { overLimit = true; local.abort(); }).finally(() => { checkingSpace = false; });
      }, 250);
      if (signal.aborted) local.abort();
      await command("ffmpeg", args, local.signal, chunk => {
        line += chunk;
        const lines = line.split(/[\r\n]/); line = lines.pop();
        for (const row of lines) { const m = /\bn:\s*\d+.*?pts_time:([\d.e+\-]+)/.exec(row); if (m) times.push(Number(m[1])); }
      });
      clearInterval(monitor); await monitorTask;
      if (overLimit) throw new Error("frame cache capacity exceeded");
      if (!validFrameTimes(times, source.fps))
        throw new Error("variable or invalid frame timestamps");
      const files = (await fsp.readdir(partial)).filter(f => f.endsWith(".png"));
      if (files.length !== times.length) throw new Error("incomplete extracted frames");
      const bytes = (await Promise.all(files.map(f => fsp.stat(path.join(partial, f))))).reduce((n, st) => n + st.size, 0);
      await this.room(root, bytes);
      const manifest = { times, bytes, width: source.width, height: source.height };
      await fsp.writeFile(path.join(partial, "manifest.json"), JSON.stringify(manifest));
      if (signal.aborted) throw new Error("cancelled");
      await fsp.rename(partial, dir);
      return manifest;
    } catch (e) { if (overLimit) throw new Error("frame cache capacity exceeded"); throw e; }
    finally { clearInterval(monitor); await monitorTask; signal.removeEventListener("abort", abort); await fsp.rm(partial, { recursive: true, force: true }); }
  }
  async block(id, projectId, clipId, block, { priority = "demand", neededAt = 0 } = {}) {
    if (!["demand", "prefetch"].includes(priority) || !Number.isFinite(neededAt) || neededAt < 0) throw new Error("invalid cache priority");
    const s = this.get(id, projectId); await s.ready;
    const source = s.sources.get(clipId);
    if (!source || s.stats.fallbacks[clipId]) return { fallback: s.stats.fallbacks[clipId] || "source unavailable" };
    if (!Number.isInteger(block) || block < Math.floor(source.start / BLOCK_SECONDS) || block > Math.floor(source.end / BLOCK_SECONDS)) throw new Error("block outside clip interval");
    try {
      const stat = await fsp.stat(source.file);
      if (`${stat.size}:${stat.mtimeMs}` !== source.stamp) throw new Error("source changed during export");
      const root = path.join(s.pp.dir, ".export-cache"); await fsp.mkdir(root, { recursive: true });
      if (!this.roots.has(root)) {
        this.roots.add(root);
        // Only stale partials from a previous crashed server are removable.
        for (const name of await fsp.readdir(root)) if (/^[a-f0-9]{64}\.partial-[a-f0-9]+$/.test(name)) {
          const partial = path.join(root, name);
          if (Date.now() - (await fsp.stat(partial)).mtimeMs > 120000) await fsp.rm(partial, { recursive: true, force: true });
        }
      }
      const key = hash(JSON.stringify([VERSION, source.hash, block, source.fps, "png-1"]));
      const dir = path.join(root, key);
      if (s.controller.signal.aborted) throw new Error("cancelled");
      this.pin(s, dir);
      // Shared media blocks may belong to multiple clips; retain separate
      // per-clip leases so prefetch for one cannot evict another's current frame.
      s.leases.set(clipId + ":" + block, { clipId, block, key, dir });
      for (const [leaseId, old] of s.leases) if (priority === "demand" && old.clipId === clipId && old.block < block - 1) {
        s.leases.delete(leaseId);
        if (![...s.leases.values()].some(b => b.dir === old.dir)) { s.blocks.delete(old.key); this.unpin(s, old.dir); }
      }
      let manifest;
      try { manifest = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"))); s.stats.hits++; }
      catch {
        s.stats.misses++;
        if (!this.jobs.has(dir)) {
          const controller = new AbortController();
          const started = Date.now();
          const queued = this.queue.enqueue(() => this.build(root, dir, source, block, controller.signal), priority, neededAt, controller.signal);
          const promise = queued.promise;
          this.jobs.set(dir, { controller, promise, queued });
          promise.finally(() => { this.jobs.delete(dir); s.stats.extractionMs += Date.now() - started; }).catch(() => {});
        }
        const job = this.jobs.get(dir);
        this.queue.promote(job.queued, priority, neededAt);
        manifest = await job.promise;
      }
      if (s.controller.signal.aborted) throw new Error("cancelled");
      const now = new Date(); await fsp.utimes(dir, now, now);
      s.blocks.set(key, { clipId, block, dir, manifest });
      s.stats.peakDiskBytes = Math.max(s.stats.peakDiskBytes, await this.room(root, 0));
      return { key, ...manifest };
    } catch (e) {
      // An unsupported source must not be re-extracted and rejected at every
      // edit that references it. Capacity/cancellation remain clip-local.
      const affected = new Set(/variable or invalid frame timestamps|incomplete extracted frames/.test(e.message)
        ? [...s.sources].filter(([, item]) => item.hash === source.hash).map(([id]) => id) : [clipId]);
      for (const id of affected) s.stats.fallbacks[id] = e.message;
      for (const [leaseId, old] of s.leases) if (affected.has(old.clipId)) {
        s.leases.delete(leaseId);
        if (![...s.leases.values()].some(b => b.dir === old.dir)) { s.blocks.delete(old.key); this.unpin(s, old.dir); }
      }
      return { fallback: e.message };
    }
  }
  drop(id, projectId, clipIds) {
    const s = this.get(id, projectId);
    if (!Array.isArray(clipIds) || clipIds.length > s.project.clips.length) throw new Error("invalid clip list");
    const clips = new Set(clipIds);
    for (const [leaseId, old] of s.leases) if (clips.has(old.clipId)) {
      s.leases.delete(leaseId);
      if (![...s.leases.values()].some(b => b.dir === old.dir)) {
        s.blocks.delete(old.key); this.unpin(s, old.dir);
        if (!this.pins.has(old.dir)) this.jobs.get(old.dir)?.controller.abort();
      }
    }
  }
  frame(id, projectId, key, index) {
    const s = this.get(id, projectId), block = s.blocks.get(key);
    if (!block || !Number.isInteger(index) || index < 0 || index >= block.manifest.times.length) throw new Error("unknown cache frame");
    return path.join(block.dir, String(index + 1).padStart(6, "0") + ".png");
  }
  release(id, projectId) {
    const s = this.sessions.get(id);
    if (!s || s.pp.id !== projectId) return;
    this.sessions.delete(id); s.controller.abort();
    for (const dir of [...s.pins]) {
      this.unpin(s, dir);
      if (!this.pins.has(dir)) this.jobs.get(dir)?.controller.abort();
    }
  }
  close() { clearInterval(this.timer); for (const s of this.sessions.values()) this.release(s.id, s.pp.id); }
}
module.exports = { ExportCache, ExtractionQueue, frameIndex, supported, validFrameTimes, localMedia, command, BLOCK_SECONDS };
