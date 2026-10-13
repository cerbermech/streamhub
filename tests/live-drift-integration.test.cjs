"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawn } = require("node:child_process");
const { Engine, terminate } = require("../src/engine.cjs");

test("real RTSP: growing backlog restarts only the slow decoder; healthy stream stays live", {
  skip: !process.env.STUDIO_TEST_MEDIAMTX || process.platform === "win32", timeout: 180000,
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streamhub-drift-"));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const config = path.join(dir, "mediamtx.json");
  fs.writeFileSync(config, JSON.stringify({ logLevel: "error", rtspAddress: "127.0.0.1:8578", rtmp: false, hls: false, webrtc: false, srt: false, paths: { all_others: { source: "publisher" } } }));
  const wrapper = path.join(dir, "slow-ffmpeg");
  // Deliberately throttle ingestion to simulate a decoder unable to keep up.
  // exec preserves the process ID so engine recovery terminates FFmpeg itself.
  fs.writeFileSync(wrapper, '#!/bin/sh\ncase "$*" in *fixture-slow*) exec ffmpeg -readrate 0.2 "$@" ;; *) exec ffmpeg "$@" ;; esac\n', { mode: 0o755 });
  let server, publisher, engine, logs = "";
  try {
    server = spawn(process.env.STUDIO_TEST_MEDIAMTX, [config], { stdio: ["ignore", "ignore", "pipe"] });
    server.stderr.on("data", b => logs += b); await wait(700);
    assert.equal(server.exitCode, null, logs);
    const pubConfig = ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10"];
    const output = name => ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "10", "-f", "rtsp", "-rtsp_transport", "tcp", "rtsp://127.0.0.1:8578/" + name];
    publisher = spawn("ffmpeg", [...pubConfig, ...output("fixture-slow"), ...output("fixture-fast")], { stdio: ["ignore", "ignore", "pipe"] });
    publisher.stderr.on("data", b => logs += b); await wait(1200);
    assert.equal(publisher.exitCode, null, logs);
    engine = new Engine({ ffmpeg: wrapper, getSource: id => ({ name: id, url: "rtsp://127.0.0.1:8578/fixture-" + id, transport: "tcp", quality: "360p" }), log: () => {}, workDir: dir });
    await engine.init();
    const fast = engine.source("fast"), slow = engine.source("slow"), fastProcess = fast.process;
    const deadline = Date.now() + 60000;
    while (!(slow.recoveries > 0) && Date.now() < deadline) await wait(200);
    assert(slow.recoveries > 0, "Slow stream was not detected: " + slow.error + " " + slow.lagMs + "\n" + logs);
    assert.equal(fast.process, fastProcess, "healthy connection must not restart with the slow one");
    assert.equal(fast.recoveries, 0);
    assert.match(slow.lastRecovery, /отставание/);
    // Real-time endurance after the recovery, not a simulated clock.
    await wait(65000);
    assert.equal(fast.process, fastProcess, "healthy decoder survives beyond the old 60-second renewal");
    assert.equal(fast.recoveries, 0);
    assert(Date.now() - fast.lastFrame < 3000, "healthy source is still delivering live video");
    assert(fast.lagMs < 1000, "relative delay stays bounded: " + fast.lagMs);
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
