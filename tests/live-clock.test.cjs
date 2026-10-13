"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { LiveClock, readProgress } = require("../src/live-clock.cjs");
const { Engine } = require("../src/engine.cjs");

test("50 normal camera timelines run for 30 minutes without false recovery", () => {
  const clocks = Array.from({ length: 50 }, () => new LiveClock());
  for (let second = 0; second <= 1800; second++) {
    for (let i = 0; i < clocks.length; i++) {
      const jitter = ((second + i) % 4) * 40;
      assert.equal(clocks[i].update((second + i * 100) * 1e6, second * 1000 + jitter), false);
      assert(clocks[i].lagMs <= 120);
    }
  }
});
test("continuous old frames at 0.05x trigger recovery instead of healthy status", () => {
  const c = new LiveClock(); let detected = false;
  for (let second = 0; second <= 12; second++)
    detected ||= c.update(second * .05 * 1e6, second * 1000);
  assert.equal(detected, true);
});
test("brief stalls, catchup and large timestamp resets do not force recovery", () => {
  const c = new LiveClock();
  assert.equal(c.update(1e6, 0), false);
  assert.equal(c.update(2e6, 5000), false);
  assert.equal(c.update(7e6, 6000), false);
  assert.equal(c.update(1e6, 7000), false);
  assert.equal(c.update(2e6, 8000), false);
  assert.equal(c.update(100e6, 9000), false);
  assert.equal(c.update(101e6, 10000), false);
});
test("constant video timestamps are detected; invalid progress is ignored", () => {
  const c = new LiveClock();
  assert.equal(c.update(NaN, 0), false);
  assert.equal(c.update(-9223372036854775807, 1000), false);
  c.update(0, 0); c.update(0, 4000);
  assert.equal(c.update(0, 10000), true);
});
test("progress parser preserves partial CRLF lines and multiple blocks", () => {
  const blocks = []; const read = readProgress(b => blocks.push(b));
  read("out_time_u"); read("s=123456\r\nprogr");
  read("ess=continue\r\nout_time_us=223456\nprogress=end\n");
  assert.deepEqual(blocks.map(b => b.out_time_us), ["123456", "223456"]);
});

test("retained recent frame does not make a reconnecting source look online", () => {
  const engine = new Engine({ ffmpeg: "ffmpeg", getSource: () => ({}), log: () => {} });
  engine.sources.set("camera", { id: "camera", state: "connecting", lastFrame: Date.now(), lastAudio: 0 });
  assert.equal(engine.status().sources[0].status, "connecting");
});

test("raw preview keeps video through unconfirmed drift and bounded recovery, then returns live frames", async () => {
  const engine = new Engine({ ffmpeg: "ffmpeg", getSource: () => ({}), log: () => {} });
  const blank = Buffer.alloc(384, 16), stale = Buffer.alloc(384, 200);
  const source = { id: "camera", state: "online", lastFrame: Date.now(), lagMs: 5000, frame: stale, cover: stale, blank };
  engine.sources.set("camera", source);
  await engine.init();
  try {
    const response = await fetch(`http://127.0.0.1:${engine.rawPort}/camera?fps=10&backup=reserve&key=${engine.token}`);
    const reader = response.body.getReader();
    const next = async () => Buffer.from((await reader.read()).value).subarray(0, blank.length);
    assert.deepEqual(await next(), stale, "single threshold crossing must not blank the picture");
    source.state = "connecting"; source.recoveryPending = true; source.recoveryHoldUntil = Date.now() + 5000;
    assert.deepEqual(await next(), stale, "confirmed short reconnect holds the last frame");
    const reserve = { state: "online", lastFrame: Date.now(), frame: Buffer.alloc(384, 80) };
    engine.sources.set("reserve", reserve);
    assert.deepEqual(await next(), reserve.frame, "a live reserve takes priority over the held frame");
    engine.sources.delete("reserve");
    source.recoveryHoldUntil = Date.now() - 1;
    assert.deepEqual(await next(), blank, "hold cannot conceal a prolonged outage");
    source.frame = Buffer.alloc(384, 100); source.state = "online"; source.recoveryPending = false; source.lastFrame = Date.now();
    assert.deepEqual(await next(), source.frame, "new live frame immediately replaces the held frame");
    await reader.cancel();
  } finally { await engine.close(); }
});
