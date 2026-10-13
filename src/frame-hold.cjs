"use strict";
const { spawn } = require("node:child_process");

// Prepare the text mask once per resolution, then cache each frozen frame.
// No FFmpeg process or full-frame blending runs for every output video tick.
class FrameHold {
  constructor(ffmpeg, fontOption, log = () => {}) {
    Object.assign(this, { ffmpeg, fontOption, log });
    this.masks = new Map();
    this.frames = new WeakMap();
    this.processes = new Set();
    this.closed = false;
  }
  prepare(w, h) {
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2 || w % 2 || h % 2) return;
    const key = `${w}x${h}`;
    if (this.masks.has(key) || this.closed) return;
    this.masks.set(key, null);
    const size = Math.max(12, Math.round(w / 48));
    const p = spawn(this.ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:r=1`,
      "-vf", `drawtext=${this.fontOption()}text='Установка соединения':x=12:y=h-text_h-48:fontsize=${size}:fontcolor=white`,
      "-frames:v", "1", "-threads", "1", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    this.processes.add(p);
    let chunks = [], length = 0, errors = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), 10000);
    p.stdout.on("data", b => { if (length + b.length <= w * h) { chunks.push(b); length += b.length; } });
    p.stderr.on("data", b => errors = (errors + String(b)).slice(-500));
    p.on("error", e => errors = e.message);
    p.once("close", code => {
      clearTimeout(timer); this.processes.delete(p);
      if (this.closed) return;
      if (code !== 0 || length !== w * h) { this.log("frame-label", errors || "Не удалось подготовить подпись соединения"); return; }
      const pixels = Buffer.concat(chunks);
      // Gray output may retain limited-range black/white (16/235).
      // Normalize the background to zero before finding the text rectangle.
      let low = 255, high = 0;
      for (const value of pixels) { low = Math.min(low, value); high = Math.max(high, value); }
      if (high === low) return;
      for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round((pixels[i] - low) * 255 / (high - low));
      let left = w, right = 0, top = h, bottom = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (pixels[y * w + x] > 0) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      if (left >= right || top >= bottom) return;
      this.masks.set(key, { pixels, left: Math.max(0, (left - 6) & ~1), top: Math.max(0, (top - 5) & ~1),
        right: Math.min(w, (right + 8) & ~1), bottom: Math.min(h, (bottom + 7) & ~1) });
    });
  }
  apply(frame, w, h) {
    this.prepare(w, h);
    const mask = this.masks.get(`${w}x${h}`);
    if (!mask || !frame || frame.length !== w * h * 1.5) return frame;
    const cached = this.frames.get(frame);
    if (cached) return cached;
    const output = Buffer.from(frame), plane = w * h;
    for (let y = mask.top; y < mask.bottom; y++) for (let x = mask.left; x < mask.right; x++) {
      const index = y * w + x, alpha = mask.pixels[index] / 255;
      const dark = 16 + Math.max(0, frame[index] - 16) * .35;
      output[index] = Math.round(dark * (1 - alpha) + 235 * alpha);
    }
    for (let y = mask.top / 2; y < mask.bottom / 2; y++) for (let x = mask.left / 2; x < mask.right / 2; x++) {
      const index = y * (w / 2) + x;
      output[plane + index] = 128;
      output[plane + plane / 4 + index] = 128;
    }
    this.frames.set(frame, output);
    return output;
  }
  close() { this.closed = true; for (const p of this.processes) p.kill("SIGKILL"); }
}
module.exports = { FrameHold };
