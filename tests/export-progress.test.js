"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createExportProgress } = require("../cli/lib/export-progress");

test("piped progress is throttled, newline-delimited and distinguishes rendered from complete", () => {
  let time = 0;
  const lines = [];
  const progress = createExportProgress({ now: () => time, write: line => lines.push(line) });
  try {
    progress.update("rendering", { frames: 1, totalFrames: 10 });
    time = 500;
    progress.update("rendering", { frames: 2, totalFrames: 10 });
    assert.equal(lines.length, 2);
    time = 2000;
    progress.update("rendering", { frames: 10, totalFrames: 10 });
    assert.match(lines.at(-1), /rendering 100.0% \(10\/10 frames\) elapsed=2s/);
    progress.update("finalizing");
    assert.match(lines.at(-1), /finalizing/);
    assert.ok(!lines.some(line => line.includes("complete")));
    progress.update("saving");
    progress.update("complete");
    assert.ok(lines.every(line => line.endsWith("\n") && !/[\r\x1b]/.test(line)));
  } finally { progress.stop(); }
});

test("older servers can report frame counts without a total", () => {
  const lines = [];
  const progress = createExportProgress({ write: line => lines.push(line) });
  try {
    progress.update("rendering", { frames: 5 });
    assert.match(lines.at(-1), /rendering 5 frames/);
    assert.ok(!lines.at(-1).includes("%"));
  } finally { progress.stop(); }
});
