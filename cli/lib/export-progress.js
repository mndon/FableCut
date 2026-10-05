"use strict";

// Newline-delimited stderr works with terminals, pipes and agent process polling.
// Frame percentage describes rendering only, not encoding/download completion.
function createExportProgress({ write = line => process.stderr.write(line), now = Date.now } = {}) {
  const started = now();
  let stage = "starting", status = {}, last = -Infinity;
  function emit(force = false) {
    const time = now();
    if (!force && time - last < 2000) return;
    last = time;
    let detail = "";
    if (stage === "rendering" && Number.isFinite(status.frames)) {
      detail = Number.isSafeInteger(status.totalFrames) && status.totalFrames > 0
        ? ` ${Math.min(100, status.frames / status.totalFrames * 100).toFixed(1)}% (${status.frames}/${status.totalFrames} frames)`
        : ` ${status.frames} frames`;
    }
    write(`[export] ${stage}${detail} elapsed=${Math.floor((time - started) / 1000)}s\n`);
  }
  emit(true);
  const timer = setInterval(() => emit(), 2000);
  timer.unref();
  return {
    update(next, value = {}) { const changed = next !== stage; stage = next; status = value; emit(changed); },
    stop() { clearInterval(timer); },
  };
}
module.exports = { createExportProgress };
