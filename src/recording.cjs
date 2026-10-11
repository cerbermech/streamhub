"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawn, spawnSync } = require("node:child_process"),
  { scheduleShouldRun, validateAutomation } = require("./scheduler.cjs");

function validateRecording(value = {}) {
  const jobs = Array.isArray(value.jobs) ? value.jobs : [];
  if (jobs.length > 100) throw Error("Не больше 100 заданий записи");
  return {
    diskLimitGb: Math.max(1, Math.min(10000, Number(value.diskLimitGb) || 50)),
    retentionDays: Math.max(
      1,
      Math.min(3650, Number(value.retentionDays) || 30),
    ),
    segmentMinutes: Math.max(
      1,
      Math.min(60, Number(value.segmentMinutes) || 5),
    ),
    jobs: jobs.map((j) => {
      if (
        !["source", "channel"].includes(j.type) ||
        typeof j.targetId !== "string"
      )
        throw Error("Неверная цель записи");
      return {
        id: /^[a-f0-9-]{36}$/.test(j.id || "") ? j.id : crypto.randomUUID(),
        name:
          String(j.name || "Запись")
            .trim()
            .slice(0, 80) || "Запись",
        type: j.type,
        targetId: j.targetId,
        enabled: j.enabled !== false,
        mode: j.mode === "schedule" ? "schedule" : "always",
        schedule: validateAutomation({ schedule: j.schedule }).schedule,
      };
    }),
  };
}

class RecordingManager {
  constructor({
    dir,
    ffmpeg,
    getSource,
    getChannel,
    getSettings,
    setSettings,
    log,
    rtspPort,
  }) {
    Object.assign(this, {
      ffmpeg,
      getSource,
      getChannel,
      getSettings,
      setSettings,
      log,
      rtspPort,
    });
    this.root = path.join(dir, "recordings");
    this.exports = path.join(dir, "exports");
    this.playback = path.join(dir, "playback-cache");
    fs.mkdirSync(this.root, { recursive: true });
    fs.mkdirSync(this.exports, { recursive: true });
    fs.mkdirSync(this.playback, { recursive: true });
    this.processes = new Map();
    this.lastErrors = new Map();
    this.closing = false;
  }
  settings() {
    return validateRecording(this.getSettings() || {});
  }
  update(value) {
    const clean = validateRecording(value);
    for (const j of clean.jobs) {
      if (j.type === "source" && !this.getSource(j.targetId))
        throw Error("Источник не найден");
      if (j.type === "channel" && !this.getChannel(j.targetId))
        throw Error("Канал не найден");
      const folder = path.join(this.root, j.id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(
        path.join(folder, "job.json"),
        JSON.stringify({
          id: j.id,
          name: j.name,
          type: j.type,
          targetId: j.targetId,
        }),
      );
    }
    this.setSettings(clean);
    this.sync();
    return clean;
  }
  shouldRun(job) {
    return (
      job.enabled &&
      (job.mode !== "schedule" ||
        scheduleShouldRun({ schedule: job.schedule, autoStart: false }))
    );
  }
  input(job) {
    if (job.type === "source") {
      const s = this.getSource(job.targetId);
      if (!s) throw Error("Источник удалён");
      return s.url.startsWith("rtsp:")
        ? ["-rtsp_transport", s.transport === "udp" ? "udp" : "tcp", "-timeout", "5000000", "-i", s.url]
        : ["-rw_timeout", "5000000", "-i", s.url];
    }
    const c = this.getChannel(job.targetId);
    if (!c) throw Error("Канал удалён");
    return [
      "-rtsp_transport",
      "tcp",
      "-i",
      `rtsp://127.0.0.1:${this.rtspPort}/channel-${c.id}`,
    ];
  }
  start(job) {
    if (this.processes.has(job.id) || this.closing) return;
    const folder = path.join(this.root, job.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
      path.join(folder, "job.json"),
      JSON.stringify({
        id: job.id,
        name: job.name,
        type: job.type,
        targetId: job.targetId,
      }),
    );
    let input;
    try {
      input = this.input(job);
    } catch (e) {
      this.lastErrors.set(job.id, e.message);
      return;
    }
    const minutes = this.settings().segmentMinutes,
      codecArgs = job.type === "source"
        ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k"]
        : ["-c", "copy"],
      args = [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-nostdin",
        ...input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        ...codecArgs,
        "-f",
        "segment",
        "-segment_time",
        String(minutes * 60),
        "-segment_atclocktime",
        "1",
        "-reset_timestamps",
        "1",
        "-segment_format_options",
        "movflags=+faststart",
        "-strftime",
        "1",
        "-y",
        path.join(folder, "%Y%m%d-%H%M%S.mp4"),
      ],
      p = spawn(this.ffmpeg, args, {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
    let err = "";
    p.stderr.on("data", (b) => {
      err = (err + String(b)).slice(-1000);
    });
    p.on("error", (e) => this.lastErrors.set(job.id, e.message));
    p.on("close", (code) => {
      this.processes.delete(job.id);
      if (!this.closing && code !== 0) {
        this.lastErrors.set(
          job.id,
          err.replace(/(?:rtsp|https?):\/\/\S+/g, "[url]") ||
            `FFmpeg: код ${code}`,
        );
        this.log(
          "recording",
          `${job.name}: запись остановлена — ${this.lastErrors.get(job.id)}`,
        );
      }
    });
    this.processes.set(job.id, p);
    this.lastErrors.delete(job.id);
    this.log("recording", `${job.name}: запись запущена`);
  }
  stop(id) {
    const p = this.processes.get(id);
    if (p && p.exitCode === null) p.kill("SIGTERM");
    // Keep the process registered until FFmpeg closes the MP4 and writes its
    // moov atom. The close handler removes it; until then the file stays active
    // and cannot be exported as a corrupt fragment.
  }
  sync() {
    const cfg = this.settings(),
      ids = new Set(cfg.jobs.map((j) => j.id));
    for (const [id] of this.processes)
      if (!ids.has(id) || !this.shouldRun(cfg.jobs.find((j) => j.id === id)))
        this.stop(id);
    for (const job of cfg.jobs)
      if (this.shouldRun(job) && !this.processes.has(job.id)) this.start(job);
    this.cleanup();
  }
  files() {
    const cfg = this.settings(),
      out = [];
    for (const jobId of fs
      .readdirSync(this.root)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))) {
      const folder = path.join(this.root, jobId),
        metaFile = path.join(folder, "job.json");
      if (!fs.existsSync(metaFile)) continue;
      let job;
      try {
        job = JSON.parse(fs.readFileSync(metaFile, "utf8"));
      } catch {
        continue;
      }
      if (!fs.existsSync(folder)) continue;
      for (const name of fs
        .readdirSync(folder)
        .filter((n) => /^\d{8}-\d{6}\.mp4$/.test(n))) {
        const file = path.join(folder, name),
          s = fs.statSync(file),
          m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/),
          startedAt = new Date(
            +m[1],
            +m[2] - 1,
            +m[3],
            +m[4],
            +m[5],
            +m[6],
          ).toISOString();
        out.push({
          id: `${jobId}~${name}`,
          jobId,
          jobName: job.name,
          type: job.type,
          targetId: job.targetId,
          name,
          size: s.size,
          startedAt,
          modifiedAt: s.mtime.toISOString(),
          active: false,
        });
      }
    }
    for (const jobId of this.processes.keys()) {
      const newest = out
        .filter((item) => item.jobId === jobId)
        .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];
      if (newest) newest.active = true;
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  resolve(id) {
    const [jobId, name, ...rest] = String(id).split("~");
    if (
      rest.length ||
      !/^[a-f0-9-]{36}$/.test(jobId) ||
      !/^\d{8}-\d{6}\.mp4$/.test(name || "")
    )
      throw Error("Неверная запись");
    const file = path.join(this.root, jobId, name);
    if (!fs.existsSync(file)) throw Error("Запись не найдена");
    return file;
  }
  cleanup() {
    const cfg = this.settings(),
      cutoff = Date.now() - cfg.retentionDays * 86400000;
    let files = this.files()
      .filter((x) => !x.active)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const item of files)
      if (Date.parse(item.startedAt) < cutoff) {
        fs.rmSync(this.resolve(item.id), { force: true });
        this.log("recording", `Удалена старая запись ${item.name}`);
      }
    files = this.files()
      .filter((x) => !x.active)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    let total = this.files().reduce((n, x) => n + x.size, 0),
      limit = cfg.diskLimitGb * 1073741824;
    for (const item of files) {
      if (total <= limit) break;
      fs.rmSync(this.resolve(item.id), { force: true });
      total -= item.size;
      this.log("recording", `Удалена запись по лимиту диска ${item.name}`);
    }
  }
  status() {
    let disk = { free: 0, total: 0 };
    try {
      const s = fs.statfsSync(this.root);
      disk = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {}
    return {
      settings: this.settings(),
      files: this.files(),
      running: [...this.processes.keys()],
      errors: Object.fromEntries(this.lastErrors),
      disk,
    };
  }
  async exportClip({ fileId, offsetSec = 0, durationSec = 60 }) {
    const input = this.resolve(fileId),
      offset = Math.max(0, Number(offsetSec) || 0),
      duration = Math.max(1, Math.min(3600, Number(durationSec) || 60)),
      id = crypto.randomUUID() + ".mp4",
      output = path.join(this.exports, id);
    await new Promise((ok, no) => {
      const p = spawn(
        this.ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-ss",
          String(offset),
          "-i",
          input,
          "-t",
          String(duration),
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          "-y",
          output,
        ],
        { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
      );
      let err = "";
      p.stderr.on("data", (b) => (err += b));
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        no(Error("Экспорт не успел завершиться"));
      }, 120000);
      p.on("close", (code) => {
        clearTimeout(timer);
        code === 0 && fs.existsSync(output)
          ? ok()
          : no(Error(err.slice(-500) || "Не удалось экспортировать"));
      });
    });
    return { id, size: fs.statSync(output).size };
  }
  resolveExport(id) {
    if (!/^[a-f0-9-]{36}\.mp4$/.test(id)) throw Error("Неверный экспорт");
    const f = path.join(this.exports, id);
    if (!fs.existsSync(f)) throw Error("Экспорт не найден");
    return f;
  }
  browserCompatible(file) {
    const probe = spawnSync(this.ffmpeg, ["-hide_banner", "-i", file], {
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    const info = String(probe.stderr || "");
    const video = info.match(/Stream #.*Video:\s*([^,\s]+)/i)?.[1]?.toLowerCase();
    const audio = info.match(/Stream #.*Audio:\s*([^,\s]+)/i)?.[1]?.toLowerCase();
    return video === "h264" && (!audio || ["aac", "mp3"].includes(audio));
  }
  async preparePlayback(fileId) {
    const input = this.resolve(fileId);
    if (this.browserCompatible(input))
      return { url: `/archive/file/${encodeURIComponent(fileId)}`, converted: false };
    const stat = fs.statSync(input),
      name = crypto
        .createHash("sha256")
        .update(`${fileId}:${stat.size}:${stat.mtimeMs}`)
        .digest("hex") + ".mp4",
      output = path.join(this.playback, name);
    if (!fs.existsSync(output) || fs.statSync(output).size < 1024) {
      await new Promise((ok, no) => {
        const p = spawn(this.ffmpeg, [
          "-hide_banner", "-loglevel", "error", "-i", input,
          "-map", "0:v:0", "-map", "0:a?",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k",
          "-movflags", "+faststart", "-y", output,
        ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        let error = "";
        p.stderr.on("data", (chunk) => (error = (error + String(chunk)).slice(-1200)));
        const timer = setTimeout(() => {
          p.kill("SIGKILL");
          no(Error("Подготовка записи заняла слишком много времени"));
        }, 600000);
        p.on("error", (e) => { clearTimeout(timer); no(e); });
        p.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && fs.existsSync(output) && fs.statSync(output).size > 1024) ok();
          else no(Error(error || "Не удалось подготовить запись для браузера"));
        });
      });
    }
    return { url: `/archive/play/${name}`, converted: true };
  }
  resolvePlayback(id) {
    if (!/^[a-f0-9]{64}\.mp4$/.test(id)) throw Error("Неверный файл просмотра");
    const file = path.join(this.playback, id);
    if (!fs.existsSync(file)) throw Error("Файл просмотра не найден");
    return file;
  }
  startLoop() {
    this.sync();
    this.timer = setInterval(() => this.sync(), 10000);
    this.timer.unref?.();
  }
  async close() {
    this.closing = true;
    clearInterval(this.timer);
    for (const [id] of this.processes) this.stop(id);
    await new Promise((r) => setTimeout(r, 300));
  }
}
module.exports = { RecordingManager, validateRecording };
