"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { Engine, terminate } = require("../src/engine.cjs");
const { explainError } = require("../src/diagnostics.cjs");

test("missing input packets are not reported as an unsupported codec", () => {
  const error = "Invalid data found when processing input\nCould not open encoder before EOF\nNothing was written into output file, because at least one of its streams received no packets.";
  assert.match(explainError(error), /Не получены видеокадры/);
  assert.match(explainError("Connection timed out\n" + error), /не ответил вовремя/);
  assert.match(explainError("401 Unauthorized\n" + error), /авторизация/);
});

test("new decoder gets a startup window despite an old displayed frame", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 100000 });
  const engine = new Engine({ ffmpeg: process.execPath, getSource: () => ({}), log: () => {} });
  const s = { id: "test", w: 16, h: 16, lastFrame: 1000, retry: null };
  engine.sources.set(s.id, s);
  engine.decode(s, { url: "rtsp://127.0.0.1/test" });
  const child = s.process;
  try {
    t.mock.timers.tick(15000);
    assert.equal(child.killed, false, "old frame must not kill the new connection");
    t.mock.timers.tick(33000);
    assert.equal(child.killed, true, "startup still has a finite timeout");
    assert.match(s.error, /первый видеокадр/);
  } finally {
    engine.closing = true;
    t.mock.timers.reset();
    await terminate(child);
  }
});

test("RTSP with a 20-second GOP and B-frames reconnects and recovers from stale frames", {
  skip: !process.env.STUDIO_TEST_MEDIAMTX, timeout: 120000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streamhub-reconnect-"));
  const config = path.join(dir, "mediamtx.json");
  fs.writeFileSync(config, JSON.stringify({ logLevel: "error", rtspAddress: "127.0.0.1:8577", rtmp: false, hls: false, webrtc: false, srt: false, paths: { all_others: { source: "publisher" } } }));
  let server, publisher, engine, logs = "";
  const delay = ms => new Promise(r => setTimeout(r, ms));
  try {
    server = spawn(process.env.STUDIO_TEST_MEDIAMTX, [config], { stdio: ["ignore", "ignore", "pipe"] });
    server.stderr.on("data", b => logs += b);
    await delay(600);
    assert.equal(server.exitCode, null, logs);
    publisher = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10", "-c:v", "libx264", "-preset", "ultrafast", "-g", "200", "-keyint_min", "200", "-sc_threshold", "0", "-bf", "2", "-f", "rtsp", "-rtsp_transport", "tcp", "rtsp://127.0.0.1:8577/long-gop"], { stdio: ["ignore", "ignore", "pipe"] });
    publisher.stderr.on("data", b => logs += b);
    await delay(1200);
    assert.equal(publisher.exitCode, null, logs);
    const conf = { url: "rtsp://127.0.0.1:8577/long-gop", transport: "tcp", quality: "360p", name: "Long GOP" };
    engine = new Engine({ ffmpeg: "ffmpeg", getSource: () => conf, log: () => {}, workDir: dir });
    await engine.init();
    const source = engine.source("camera");
    const waitFrame = async () => {
      const deadline = Date.now() + 45000;
      while (source.state !== "online" && Date.now() < deadline) await delay(100);
      assert.equal(source.state, "online", source.error + "\n" + logs);
      assert.equal(source.frame.length, source.w * source.h * 1.5);
    };
    await waitFrame();
    for (let i = 0; i < 2; i++) {
      const old = source.process;
      await engine.restartSource(source.id);
      const decoder = source.process;
      // Model a retained display frame from a previous disconnected session.
      source.lastFrame = Date.now() - 60000;
      await delay(3500);
      assert.notEqual(source.process, old);
      await waitFrame();
      assert.equal(source.process, decoder, "first frame must arrive without a watchdog restart");
      assert.equal(source.error, "");
    }
  } finally {
    if (engine) {
      engine.closing = true;
      for (const s of engine.sources.values()) { clearTimeout(s.retry); await terminate(s.process); }
      await engine.close();
    }
    await terminate(publisher); await terminate(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
