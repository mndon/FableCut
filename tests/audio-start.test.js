"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

for (const kind of ["video", "audio"]) {
  test(`${kind}: first-play handoff restores prewarmed source volume without unmuting it early`, async () => {
    const clip = { id: "first", kind, track: kind === "video" ? "V1" : "A1", props: { volume: 0.7 } };
    // Before the first user gesture, preview mutes the native element, since
    // AudioContext and the per-clip gain do not exist yet.
    const el = { volume: 0, paused: true, play() { this.paused = false; return Promise.resolve(); },
      pause() { this.paused = true; } };
    const runtime = { clipEls: new Map([[clip.id, el]]), clipGain: new Map(),
      previewMedia: new Map([[clip.id, { ready: true }]]), audio: { ctx: {
        createMediaElementSource: () => ({}), createGain: () => ({ gain: { value: 1 } }),
      } } };
    const context = vm.createContext({ runtime, state: { playing: false, time: 0 },
      connectChannelIsolated: () => ({ split: null, merge: null }),
      routeClipGain() { assert.equal(runtime.clipGain.get(clip.id).gain.value, 0); },
      getClip: () => clip, isTrackEnabled: () => true, activeAt: () => true,
      evalProps: c => c.props, clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    });
    vm.runInContext(section('function hookAudio(c, el)', '/** Reconnect a clip') +
      section('function syncMedia()', 'function seekMediaWhilePaused()'), context);
    context.hookAudio(clip, el);
    const gain = runtime.clipGain.get(clip.id);
    assert.equal(el.volume, 1);
    assert.equal(gain.gain.value, 0, "preloaded clip stays silent after connection");
    context.state.playing = true;
    context.syncMedia();
    assert.equal(el.volume * gain.gain.value, 0.7, "first clip has its intended output level");
    assert.equal(el.paused, false);
    await Promise.resolve();
    clip.props.volume = 0;
    context.syncMedia();
    assert.equal(el.volume * gain.gain.value, 0, "intentionally muted clips remain silent");
    context.state.playing = false;
    context.syncMedia();
    assert.equal(el.paused, true);
    assert.equal(gain.gain.value, 0);
  });
}
