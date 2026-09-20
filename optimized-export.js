/* Separate opt-in exporter. The compositor and audio mixer live in app.js. */
"use strict";
class OrderedFrameQueue {
  constructor(write, maxFrames = 4, maxBytes = 32 * 1024 ** 2) {
    this.write = write; this.maxFrames = maxFrames; this.maxBytes = maxBytes;
    this.pending = []; this.bytes = 0; this.peakBytes = 0; this.error = null;
  }
  async push(blob) {
    while (this.pending.length && (this.pending.length >= this.maxFrames || this.bytes + blob.size > this.maxBytes)) await this.pending[0];
    if (this.error) throw this.error;
    this.bytes += blob.size; this.peakBytes = Math.max(this.peakBytes, this.bytes);
    const previous = this.pending.at(-1) || Promise.resolve();
    const task = previous.then(() => { if (this.error) throw this.error; return this.write(blob); })
      .catch(e => { this.error = e; }).finally(() => { this.bytes -= blob.size; this.pending.shift(); });
    this.pending.push(task);
  }
  async finish() { await Promise.all(this.pending); if (this.error) throw this.error; }
  cancel() { this.error = this.error || new Error("cancelled"); }
}
function cachedFrameIndex(times, time) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (times[mid] <= time + 1e-5) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
function sourceBlockPlan(clips, fps) {
  const plan = [];
  for (const clip of clips) {
    const speed = Math.max(0.1, Math.min(8, Number(clip.props?.speed) || 1));
    const end = clip.start + clip.duration;
    let frame = Math.max(0, Math.ceil(clip.start * fps - 1e-7));
    while (frame / fps < end) {
      const neededAt = frame / fps, time = clip.in + (neededAt - clip.start) * speed;
      const block = Math.floor(time / 5);
      plan.push({ clip, time, block, neededAt });
      // Jump to the first output sample in the next source block. This plans
      // every used block without iterating over every frame of the project.
      frame = Math.max(frame + 1, Math.ceil((clip.start + ((block + 1) * 5 - clip.in) / speed) * fps - 1e-7));
    }
  }
  return plan.sort((a, b) => a.neededAt - b.neededAt);
}
function sourceReadAhead(clips, time, fps) {
  return sourceBlockPlan(clips, fps).filter(item => item.neededAt > time).slice(0, 3);
}
class SourceReadAhead {
  constructor(load, requested) { this.load = load; this.requested = requested; this.plan = []; this.active = null; this.stopped = false; }
  update(plan) { this.plan = plan; this.pump(); }
  pump() {
    if (this.stopped || this.active) return;
    const next = this.plan.find(item => !this.requested(item));
    if (!next) return;
    // One speculative request at a time; demand reads can proceed independently.
    // In particular, rendering never awaits this promise for a future clip.
    this.active = Promise.resolve().then(() => this.load(next)).catch(() => {}).finally(() => {
      this.active = null; this.pump();
    });
  }
  stop() { this.stopped = true; this.plan = []; return this.active || Promise.resolve(); }
}
class FrameReadAhead {
  constructor(load, concurrency = 2) {
    this.load = load; this.concurrency = concurrency; this.plan = []; this.active = new Map(); this.stopped = false;
  }
  update(plan) { if (!this.stopped) { this.plan = plan; this.pump(); } }
  pump() {
    while (!this.stopped && this.active.size < this.concurrency && this.plan.length) {
      const item = this.plan.shift();
      if (this.active.has(item.key)) continue;
      const task = Promise.resolve().then(() => this.load(item)).catch(() => {}).finally(() => {
        this.active.delete(item.key); this.pump();
      });
      this.active.set(item.key, task);
    }
  }
  async stop() { this.stopped = true; this.plan = []; await Promise.all(this.active.values()); }
}
// Capture stays ordered; only immutable snapshots may outlive the current frame.
class SnapshotPipeline {
  constructor(capture, write, depth = 2) { this.capture = capture; this.write = write; this.depth = depth; this.pending = []; }
  async push(canvas) {
    while (this.pending.length >= this.depth) await this.drain();
    const job = await this.capture(canvas);
    job.result.catch(() => {}); // Observe errors even if a later source read fails.
    this.pending.push(job);
  }
  async drain() { const job = this.pending.shift(); if (job) await this.write(await job.result); }
  async finish() { while (this.pending.length) await this.drain(); }
  async settle() { await Promise.allSettled(this.pending.splice(0).map(job => job.result)); }
}
function createSnapshotEncoder(signal) {
  let worker, sequence = 0;
  const pending = new Map();
  const close = () => {
    worker?.terminate(); worker = null;
    for (const { reject } of pending.values()) reject(new Error("snapshot encoder stopped"));
    pending.clear(); signal.removeEventListener("abort", close);
  };
  if (typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof createImageBitmap === "function") {
    try {
      worker = new Worker("optimized-encoder-worker.js");
      worker.onmessage = ({ data }) => {
        const job = pending.get(data.id); if (!job) return;
        pending.delete(data.id); data.error ? job.reject(new Error(data.error)) : job.resolve(data.blob);
      };
      worker.onerror = e => { e.preventDefault(); close(); };
      signal.addEventListener("abort", close, { once: true });
    } catch { close(); }
  }
  return {
    close,
    async capture(canvas) {
      if (signal.aborted) throw new Error("cancelled");
      // Legacy fallback is deliberately sequential: the next draw cannot race it.
      if (!worker) return { result: Promise.resolve(await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.95))) };
      const bitmap = await createImageBitmap(canvas);
      if (signal.aborted) { bitmap.close(); throw new Error("cancelled"); }
      const id = sequence++;
      const result = (async () => {
        // Clone the immutable bitmap through the graphics API, then transfer it.
        // Structured cloning in postMessage can force an expensive pixel copy.
        const transferable = await createImageBitmap(bitmap);
        return new Promise((resolve, reject) => {
          if (signal.aborted || !worker) { transferable.close(); reject(new Error("snapshot encoder stopped")); return; }
          pending.set(id, { resolve, reject });
          try { worker.postMessage({ id, bitmap: transferable }, [transferable]); }
          catch (e) { transferable.close(); pending.delete(id); reject(e); }
        });
      })().catch(async e => {
        if (signal.aborted) throw e;
        close();
        const fallback = document.createElement("canvas");
        fallback.width = bitmap.width; fallback.height = bitmap.height;
        try {
          fallback.getContext("2d").drawImage(bitmap, 0, 0);
          return await new Promise(resolve => fallback.toBlob(resolve, "image/jpeg", 0.95));
        } finally { fallback.width = fallback.height = 0; }
      }).finally(() => bitmap.close());
      result.catch(() => {});
      return { result };
    },
  };
}
let optimizedSources = null, optimizedAbort = null, optimizedMaskCanvas = null;
function optimizedMaskSource(source) {
  if (!optimizedMaskCanvas) optimizedMaskCanvas = document.createElement("canvas");
  if (optimizedMaskCanvas.width !== source.width) optimizedMaskCanvas.width = source.width;
  if (optimizedMaskCanvas.height !== source.height) optimizedMaskCanvas.height = source.height;
  optimizedMaskCanvas.getContext("2d").drawImage(source, 0, 0);
  return optimizedMaskCanvas;
}
async function optimizedExport(options = {}) {
  if (state.exporting) return;
  pause();
  state.exporting = true; state.rendering = true; renderCancelled = false;
  const started = performance.now(), controller = new AbortController(); optimizedAbort = controller;
  const stats = { engine: "optimized", frames: 0, phases: {}, samples: {}, peakDecodedBytes: 0, peakQueueBytes: 0 };
  const sample = (name, ms) => {
    const s = stats.samples[name] || (stats.samples[name] = { count: 0, totalMs: 0, maxMs: 0, histogram: Array(24).fill(0) });
    s.count++; s.totalMs += ms; s.maxMs = Math.max(s.maxMs, ms); s.histogram[Math.min(23, Math.max(0, Math.ceil(Math.log2(Math.max(1, ms)))))]++;
  };
  const checked = () => { if (renderCancelled || controller.signal.aborted) throw new Error("cancelled"); };
  const api = async (url, body, method) => {
    checked();
    const response = await fetch(url, { method: method || (body === undefined ? "GET" : "POST"),
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body), signal: controller.signal });
    const result = await response.json();
    if (!response.ok || result.error) throw new Error(result.error || "Export request failed");
    return result;
  };
  let cacheId, sessionId, heartbeat, queue, originalProject, cacheStatus, imageBytes = 0, encoder, readAhead, frameReadAhead, pipeline;
  let currentKeep = new Set();
  const images = new Map(), manifests = new Map(), readyManifests = new Map(), failedClips = new Set(), demanded = new Set();
  const cacheUrl = (route, query = "") => projectApi(`/api/export/cache/${route}`) + `&id=${cacheId}${query}`;
  const release = () => {
    if (cacheId) fetch(cacheUrl("release"), { method: "POST", keepalive: true }).catch(() => {});
    if (sessionId) fetch(`/api/export/end?id=${sessionId}&discard=1`, { method: "POST", keepalive: true }).catch(() => {});
  };
  const exit = () => { controller.abort(); release(); };
  const preventEdit = e => { if (e.key === "Escape") { renderCancelled = true; controller.abort(); } e.stopImmediatePropagation(); e.preventDefault(); };
  window.addEventListener("pagehide", exit);
  window.addEventListener("keydown", preventEdit, true);
  els.exportOverlay.classList.remove("hidden"); els.exportProgress.style.width = "0%";
  els.exportTitle.textContent = "Preparing source frames…";
  els.exportNote.textContent = "Pre-decoding video and caching frames. You can switch tabs.";
  try {
    // Let an already scheduled save settle; never force-overwrite a newer revision.
    const deadline = performance.now() + 5000;
    while (true) {
      checked();
      const disk = await api(projectApi("/api/project"));
      if (!runtime.saveTimer && disk.revision === project.revision) break;
      if (performance.now() > deadline) throw new Error("Project is not saved or changed externally. Reload/save before exporting.");
      await new Promise(r => setTimeout(r, 100));
    }
    originalProject = { ...project }; Object.assign(project, JSON.parse(JSON.stringify(project)));
    const caps = await api("/api/export/ffmpeg");
    if (!caps.available || !caps.ffprobe) throw new Error("Optimized export needs ffmpeg and ffprobe");
    cacheId = (await api(projectApi("/api/export/cache/begin"), { revision: project.revision })).id;
    heartbeat = setInterval(() => { api(cacheUrl("status")).then(s => { cacheStatus = s; }).catch(() => {}); }, 15000);
    do {
      cacheStatus = await api(cacheUrl("status"));
      if (cacheStatus.state === "error") throw new Error(cacheStatus.error);
      if (cacheStatus.state !== "ready") await new Promise(r => setTimeout(r, 100));
    } while (cacheStatus.state !== "ready");
    const eligible = new Set(cacheStatus.clips);
    const fallback = (c, reason) => { failedClips.add(c.id); stats.fallbacks ||= {}; stats.fallbacks[c.id] = reason; };
    const blockFor = (c, time, speculative = false, neededAt = 0) => {
      const block = Math.floor(time / 5), key = c.id + ":" + block;
      if (!speculative && !demanded.has(key)) {
        demanded.add(key);
        // Promote an already queued prefetch; retain the original result promise.
        if (manifests.has(key) && !readyManifests.has(key))
          api(cacheUrl("block"), { clipId: c.id, block, priority: "demand" }).catch(() => {});
      }
      if (!manifests.has(key)) {
        const promise = api(cacheUrl("block"), { clipId: c.id, block, priority: speculative ? "prefetch" : "demand", neededAt }).then(m => {
          if (m.fallback) fallback(c, m.fallback);
          readyManifests.set(key, m);
          return m;
        }).catch(e => { fallback(c, e.message); return { fallback: e.message }; });
        manifests.set(key, promise);
        for (const k of manifests.keys()) if (k.startsWith(c.id + ":") && !speculative && Number(k.slice(c.id.length + 1)) < block - 1) { manifests.delete(k); readyManifests.delete(k); }
      }
      return manifests.get(key);
    };
    const evict = (keep, required = 0) => {
      for (const [key, item] of images) {
        if (imageBytes + required <= 128 * 1024 ** 2) break;
        if (keep.has(key) || !item.img) continue;
        item.img.close(); imageBytes -= item.bytes; images.delete(key);
      }
    };
    const imageFor = async (c, time, keep, prefetch = false) => {
      const keyForBlock = c.id + ":" + Math.floor(time / 5);
      if (prefetch && !readyManifests.has(keyForBlock)) {
        // The timeline planner owns extraction order; near-frame image prefetch
        // must not enqueue a block ahead of an earlier timeline requirement.
        return null;
      }
      if (!prefetch && !readyManifests.has(keyForBlock) && stats.frames > 0) {
        els.exportTitle.textContent = "Preparing video frames…";
        els.exportNote.textContent = "Preparing the next part of your video. Export will continue automatically.";
      }
      const m = prefetch ? readyManifests.get(keyForBlock) : await blockFor(c, time);
      if (m.fallback) return null;
      const index = cachedFrameIndex(m.times, time);
      if (index < 0 || time > m.times.at(-1) + (m.times.length > 1 ? m.times[1] - m.times[0] : 0.1) + 1e-5) {
        if (!prefetch) fallback(c, "source time outside cached coverage");
        return null;
      }
      const key = m.key + ":" + index;
      if (!prefetch) keep.add(key);
      let item = images.get(key);
      if (!item) {
        evict(keep, m.width * m.height * 4);
        if (prefetch && imageBytes + m.width * m.height * 4 > 128 * 1024 ** 2) return null;
        item = { bytes: m.width * m.height * 4, img: null };
        imageBytes += item.bytes; stats.peakDecodedBytes = Math.max(stats.peakDecodedBytes, imageBytes);
        item.promise = (async () => {
          let img;
          try {
            let tick = performance.now();
            const response = await fetch(cacheUrl("frame", `&key=${m.key}&index=${index}`), { signal: controller.signal });
            if (!response.ok) throw new Error("Cached source frame unavailable");
            const blob = await response.blob(); sample("sourceFetch", performance.now() - tick);
            tick = performance.now(); img = await createImageBitmap(blob); sample("sourceDecode", performance.now() - tick);
            checked(); item.img = img; return img;
          } catch (e) { img?.close(); imageBytes -= item.bytes; images.delete(key); throw e; }
        })();
        images.set(key, item);
      } else { images.delete(key); images.set(key, item); }
      return item.promise;
    };
    const fps = project.fps, dur = Math.max(1 / fps, projDur()), count = Math.max(1, Math.round(dur * fps));
    const videoClips = project.clips.filter(c => c.kind === "video" && isTrackEnabled(c.track));
    const blockPlan = sourceBlockPlan(videoClips.filter(c => eligible.has(c.id)), fps);
    readAhead = new SourceReadAhead(
      request => blockFor(request.clip, request.time, true, request.neededAt),
      request => failedClips.has(request.clip.id) || manifests.has(request.clip.id + ":" + Math.floor(request.time / 5)));
    const dropped = new Set();
    const prepare = async t => {
      const ended = videoClips.filter(c => c.start + c.duration <= t && !dropped.has(c.id));
      if (ended.length) {
        await api(cacheUrl("drop"), { clipIds: ended.map(c => c.id) });
        for (const c of ended) dropped.add(c.id);
      }
      optimizedSources = new Map(); const keep = currentKeep = new Set();
      await Promise.all(videoClips.filter(c => activeAt(c, t)).map(async c => {
        const time = mediaTimeAt(c, t);
        if (eligible.has(c.id) && !failedClips.has(c.id)) {
          try { const img = await imageFor(c, time, keep); if (img) { optimizedSources.set(c.id, img); return; } }
          catch (e) { checked(); fallback(c, e.message); }
        }
        await prepareVideoFrame(c, getClipEl(c), time);
      }));
      evict(keep);
      // Keep only three future clip/block requirements leased, including
      // interior blocks of upcoming clips. Completed entries still occupy the
      // window until consumed, preventing unbounded speculative cache growth.
      readAhead.update(blockPlan.filter(item => item.neededAt > t && !failedClips.has(item.clip.id)).slice(0, 3));
      return keep;
    };
    // Warm the opening frame before audio; subsequent blocks are demand/prefetch driven.
    await prepare(0);
    stats.phases.prepareMs = performance.now() - started;
    els.exportTitle.textContent = "Mixing audio…";
    let tick = performance.now(); const wav = await renderAudioMix(dur); checked(); stats.phases.audioMs = performance.now() - tick;
    const name = options.name || project.name.replace(/[^\w\- ]+/g, "") || "export";
    sessionId = (await api(projectApi("/api/export/begin"), { fps, name, requestId: options.requestId, engine: "optimized", cacheId })).id;
    if (wav) await api(`/api/export/audio?id=${sessionId}`, wav);
    await document.fonts.ready;
    if (project.clips.some(c => isTrackEnabled(c.track) && c.props?.bgRemove)) await ensureBgSeg();
    queue = new OrderedFrameQueue(async blob => { const t = performance.now(); await api(`/api/export/frame?id=${sessionId}`, blob); sample("upload", performance.now() - t); });
    encoder = createSnapshotEncoder(controller.signal);
    const snapshotDepth = Math.max(1, Math.min(2, Math.floor(64 * 1024 ** 2 / (project.width * project.height * 4))));
    stats.snapshotDepth = snapshotDepth;
    pipeline = new SnapshotPipeline(async canvas => {
      const tick = performance.now(), job = await encoder.capture(canvas);
      sample("snapshot", performance.now() - tick);
      job.result = job.result.then(blob => { sample("jpeg", performance.now() - tick); return blob; });
      return job;
    }, async blob => {
      if (!blob?.size) throw new Error("Canvas returned an empty frame");
      const tick = performance.now(); await queue.push(blob); sample("queueWait", performance.now() - tick);
    }, snapshotDepth);
    frameReadAhead = new FrameReadAhead(async ({ clip, time }) => {
      if (failedClips.has(clip.id) || dropped.has(clip.id)) return;
      const tick = performance.now();
      // Speculation may fail when a finished clip releases its lease. A demand
      // read decides whether to fall back; speculation must not change pixels.
      await imageFor(clip, time, currentKeep, true);
      sample("prefetch", performance.now() - tick);
    });
    const renderingStarted = performance.now();
    for (let f = 0; f < count; f++) {
      checked(); const t = f / fps; state.time = t;
      tick = performance.now(); const keep = await prepare(t); sample("source", performance.now() - tick);
      if (videoClips.some(c => c.start > (f - 1) / fps && c.start <= t)) sample("cutSourceWait", performance.now() - tick);
      tick = performance.now(); await prepareFrameAssets(t); sample("assets", performance.now() - tick);
      tick = performance.now(); drawFrame(t); sample("composite", performance.now() - tick);
      tick = performance.now();
      const plan = [];
      for (let offset = 1; offset <= 4 && f + offset < count; offset++) {
        const next = (f + offset) / fps;
        for (const c of videoClips) if (activeAt(c, next) && eligible.has(c.id) && !failedClips.has(c.id))
          plan.push({ key: `${c.id}:${f + offset}`, clip: c, time: mediaTimeAt(c, next) });
      }
      frameReadAhead.update(plan);
      await pipeline.push(els.preview); sample("pipeline", performance.now() - tick);
      stats.frames++;
      evict(keep);
      const pct = (f + 1) / count * 100;
      els.exportProgress.style.width = pct.toFixed(1) + "%";
      els.exportTitle.textContent = `Rendering… ${pct.toFixed(0)}%`;
      els.exportNote.textContent = `Cached video frames · ${new Set([...Object.keys(cacheStatus.stats.fallbacks), ...failedClips]).size} compatibility fallbacks · You can switch tabs.`;
    }
    await pipeline.finish(); await queue.finish(); await frameReadAhead.stop(); stats.peakQueueBytes = queue.peakBytes;
    stats.phases.renderMs = performance.now() - renderingStarted;
    cacheStatus = await api(cacheUrl("status")); stats.cache = cacheStatus.stats;
    for (const s of Object.values(stats.samples)) {
      let n = 0; s.meanMs = s.totalMs / s.count;
      for (let i = 0; i < s.histogram.length; i++) { n += s.histogram[i]; if (n >= s.count * 0.95) { s.p95UpperMs = 2 ** i; break; } }
    }
    els.exportTitle.textContent = "Encoding…"; tick = performance.now();
    stats.totalMs = performance.now() - started;
    const result = await api(`/api/export/end?id=${sessionId}`, { metrics: stats }); sessionId = null;
    stats.phases.finalizeMs = performance.now() - tick; stats.totalMs = performance.now() - started;
    stats.fps = count / (stats.totalMs / 1000);
    if (!options.requestId) { const a = document.createElement("a"); a.href = result.src; a.download = decodeURIComponent(result.src.split("/").pop()); a.click();
      toast(`Optimized export complete: ${(stats.totalMs / 1000).toFixed(1)}s · ${stats.cache.hits} cache hits`); }
    console.info("Optimized export", stats);
  } catch (e) {
    queue?.cancel(); controller.abort(); await queue?.finish().catch(() => {});
    const message = renderCancelled || e.name === "AbortError" ? "cancelled" : e.message;
    if (options.requestId) await fetch(projectApi("/api/export/report"), { method: "POST", body: JSON.stringify({ requestId: options.requestId, error: message }) }).catch(() => {});
    else if (message !== "cancelled") alert("Optimized export failed: " + message);
  } finally {
    clearInterval(heartbeat); release(); encoder?.close();
    controller.abort(); await readAhead?.stop(); await frameReadAhead?.stop(); await pipeline?.settle(); optimizedAbort = null; optimizedSources = null;
    for (const item of images.values()) if (item.img) item.img.close();
    images.clear();
    if (optimizedMaskCanvas) { optimizedMaskCanvas.width = 0; optimizedMaskCanvas.height = 0; optimizedMaskCanvas = null; }
    if (originalProject) Object.assign(project, originalProject);
    state.exporting = false; state.rendering = false;
    window.removeEventListener("pagehide", exit); window.removeEventListener("keydown", preventEdit, true);
    els.exportOverlay.classList.add("hidden");
    els.exportNote.textContent = "Rendering your sequence in real time. Keep this tab focused.";
    if (runtime.pendingSync) syncFromServer();
  }
}
if (typeof module !== "undefined") module.exports = { OrderedFrameQueue, cachedFrameIndex, sourceBlockPlan, sourceReadAhead, SourceReadAhead, FrameReadAhead, SnapshotPipeline, createSnapshotEncoder };
