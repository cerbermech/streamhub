"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { FrameHold } = require("../src/frame-hold.cjs");

test("connection label renders only a small lower strip, preserves the frame, and is cached", {
  skip: !process.env.STUDIO_TEST_MEDIAMTX, timeout: 15000,
}, async () => {
  const hold = new FrameHold("ffmpeg", () => "");
  try {
    const w = 640, h = 360, frame = Buffer.alloc(w * h * 1.5, 128); frame.fill(90, 0, w * h);
    const original = Buffer.from(frame);
    hold.prepare(w, h);
    const deadline = Date.now() + 10000;
    while (!hold.masks.get(`${w}x${h}`) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    const mask = hold.masks.get(`${w}x${h}`);
    assert(mask, "actual FFmpeg must render the Cyrillic label");
    assert(mask.top > h * .8 && mask.right < w * .7, "label stays small and at the bottom");
    const marked = hold.apply(frame, w, h);
    assert.notDeepEqual(marked, frame);
    assert.deepEqual(marked.subarray(0, w * mask.top), frame.subarray(0, w * mask.top));
    assert.deepEqual(frame, original, "held original must not be modified");
    assert.equal(hold.apply(frame, w, h), marked, "repeated output reuses the rendered frame");
  } finally { hold.close(); }
});
