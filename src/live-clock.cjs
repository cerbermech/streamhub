"use strict";

// Relative delay, not absolute camera time: timestamp origins differ by device.
// Track the freshest observed wall/media offset and detect growing backlog.
class LiveClock {
  constructor({ limitMs = 3000, sustainMs = 5000 } = {}) {
    Object.assign(this, { limitMs, sustainMs });
    this.offset = null;
    this.previous = null;
    this.lagMs = 0;
    this.since = null;
  }
  update(mediaUs, now) {
    if (!Number.isFinite(mediaUs) || mediaUs < 0) return false;
    const mediaMs = mediaUs / 1000;
    const previous = this.previous;
    // A genuine timestamp discontinuity starts a new timeline. Repeated
    // timestamps do not: they must still be diagnosed as stalled video.
    if (previous && (mediaMs < previous.mediaMs - 1000 ||
        mediaMs - previous.mediaMs > now - previous.now + 30000)) {
      this.offset = null;
      this.since = null;
    }
    this.previous = { mediaMs, now };
    const offset = now - mediaMs;
    this.offset = this.offset === null ? offset : Math.min(this.offset, offset);
    this.lagMs = Math.max(0, offset - this.offset);
    if (this.lagMs > this.limitMs) this.since ??= now;
    else this.since = null;
    return this.since !== null && now - this.since >= this.sustainMs;
  }
}

// FFmpeg progress is a stream: both lines and blocks may cross pipe chunks.
function readProgress(onBlock) {
  let pending = "", values = {};
  return (chunk) => {
    pending += String(chunk);
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      const equal = line.indexOf("=");
      if (equal <= 0) continue;
      values[line.slice(0, equal)] = line.slice(equal + 1);
      if (line.startsWith("progress=")) { onBlock(values); values = {}; }
    }
    if (pending.length > 16384) pending = "";
  };
}

module.exports = { LiveClock, readProgress };
