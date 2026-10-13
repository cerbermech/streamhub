"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const dimensions = (q) =>
  q === "1080p" ? [1920, 1080] : q === "360p" ? [640, 360] : [1280, 720];
const { rectangles, canvasRects } = require("./layouts.js");
const path = require("node:path");
const { LiveClock, readProgress } = require("./live-clock.cjs");
const silence = Buffer.alloc(3840);
function launch(cmd, args, onLog) {
  const p = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  p.stderr.on("data", (b) => onLog(String(b)));
  p.on("error", (e) => onLog(e.message));
  return p;
}
async function terminate(p) {
  if (!p || p.exitCode !== null || p.signalCode) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      resolve();
    }, 2500);
    p.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    p.kill("SIGTERM");
  });
}
class Engine {
  constructor({ ffmpeg, rawPort = 0, getSource, log, workDir }) {
    Object.assign(this, { ffmpeg, rawPort, getSource, log, workDir });
    this.fontFile = [
      process.resourcesPath && path.join(process.resourcesPath, "assets", "DejaVuSans.ttf"),
      path.join(__dirname, "assets", "DejaVuSans.ttf"),
      "C:\\Windows\\Fonts\\arial.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ].find((file) => file && fs.existsSync(file));
    this.sources = new Map();
    this.channels = new Map();
    this.token = randomBytes(24).toString("hex");
    this.closing = false;
  }
  fontOption(){return this.fontFile?`fontfile='${this.fontFile.replace(/\\/g,"/").replace(/:/g,"\\:").replace(/'/g,"\\'")}':`:""}
  placeholder(w,h,name){const fallback=Buffer.alloc(w*h*3/2,128);fallback.fill(20,0,w*h);try{const safe=String(name||"Источник").replace(/[':\\]/g," ").slice(0,60),font=this.fontOption(),p=spawnSync(this.ffmpeg,["-hide_banner","-loglevel","error","-f","lavfi","-i",`color=c=0x161f26:s=${w}x${h}:r=1`,"-vf",`drawtext=${font}text='НЕТ СИГНАЛА':x=(w-text_w)/2:y=(h-text_h)/2-18:fontsize=${Math.max(22,Math.round(w/24))}:fontcolor=white,drawtext=${font}text='${safe}':x=(w-text_w)/2:y=(h-text_h)/2+36:fontsize=${Math.max(15,Math.round(w/40))}:fontcolor=0x9aafbd`,"-frames:v","1","-pix_fmt","yuv420p","-f","rawvideo","pipe:1"],{encoding:null,timeout:5000,maxBuffer:w*h*2});return p.status===0&&p.stdout.length===fallback.length?p.stdout:fallback}catch{return fallback}}
  async init() {
    this.rawServer = http.createServer((q, r) => {
      const u = new URL(q.url, "http://localhost");
      if (u.searchParams.get("key") !== this.token) {
        r.writeHead(403).end();
        return;
      }
      const id = u.pathname.slice(1);
      const s = this.sources.get(id);
      if (!s) {
        r.writeHead(404).end();
        return;
      }
      if (u.searchParams.get("audio") === "1") {
        r.writeHead(200, { "Content-Type": "application/octet-stream" });
        const queue = [];
        s.audioClients.add(queue);
        let blocked = false;
        r.on("drain", () => (blocked = false));
        const t = setInterval(() => {
          if (!blocked && !r.destroyed)
            blocked = !r.write(queue.shift() || silence);
        }, 20);
        r.on("close", () => {
          clearInterval(t);
          s.audioClients.delete(queue);
        });
        return;
      }
      const fps = Number(u.searchParams.get("fps"));
      if (![10, 15, 25].includes(fps)) {
        r.writeHead(400).end();
        return;
      }
      r.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      });
      let blocked = false,
        lastVideoFrame = null;
      const send = () => {
        if (blocked || r.destroyed) return;
        const delay=Math.max(4,Math.min(60,Number(u.searchParams.get("delay"))||5))*1000,
          reserve=this.sources.get(u.searchParams.get("backup")),
          selected=s.state==="online"&&s.lagMs<=3000&&Date.now()-s.lastFrame<delay?s:reserve&&reserve.state==="online"&&reserve.lagMs<=3000&&Date.now()-reserve.lastFrame<4000?reserve:null,
          fit=u.searchParams.get("fit") === "cover" ? "cover" : "frame";
        if (selected) lastVideoFrame=selected[fit];
        else if (s.lagMs>3000) lastVideoFrame=s.blank;
        else if (!lastVideoFrame && s.lastFrame) lastVideoFrame=s[fit];
        blocked = !r.write(lastVideoFrame || s.blank);
      };
      r.on("drain", () => (blocked = false));
      send();
      const t = setInterval(send, 1000 / fps);
      r.on("close", () => clearInterval(t));
    });
    await new Promise((ok, no) => {
      this.rawServer.once("error", no);
      this.rawServer.listen(this.rawPort, "127.0.0.1", ok);
    });
    this.rawPort = this.rawServer.address().port;
  }
  source(id) {
    let s = this.sources.get(id);
    if (s) return s;
    const conf = this.getSource(id);
    if (!conf) throw Error("Источник не найден");
    const [w, h] = dimensions(conf.quality);
    const blank = this.placeholder(w,h,conf.name);
    s = {
      id,
      w,
      h,
      blank,
      audioClients: new Set(),
      audioRefs: 0,
      audioProcess: null,
      audioRetry: null,
      lastAudio: 0,
      audioError: "",
      frame: blank,
      cover: blank,
      lastFrame: 0,
      state: "connecting",
      refs: 0,
      process: null,
      retry: null,
      retryAttempt: 0,
      startedAt: 0,
      error: "",
      lagMs: 0,
      recoveries: 0,
      lastRecovery: "",
    };
    this.sources.set(id, s);
    this.decode(s, conf);
    return s;
  }
  decode(s, conf) {
    clearTimeout(s.retry);
    s.retry = null;
    if (!conf || !conf.url) {
      s.state = "offline";
      s.error = "Конфигурация источника недоступна";
      return this.scheduleDecode(s);
    }
    if (conf.enabled === 0 || conf.enabled === false) {
      s.state = "disabled";
      s.error = "";
      return;
    }
    const W = s.w,
      H = s.h,
      FRAME = W * H * 3;
    if (this.closing || !this.sources.has(s.id)) return;
    const input = conf.url.startsWith("rtsp:")
      ? ["-rtsp_transport", conf.transport === "udp" ? "udp" : "tcp", "-timeout", "15000000"]
      : [
          "-rw_timeout",
          "5000000",
          "-protocol_whitelist",
          "http,https,tcp,tls,crypto",
        ];
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostdin",
      "-threads",
      "1",
      // Keep packets collected during probing: they may contain the only
      // keyframe until the next GOP. Forced low_delay also breaks reordering.
      ...input,
      "-i",
      conf.url,
      "-an",
      "-sn",
      "-dn",
      "-filter_complex_threads",
      "1",
      "-filter_complex",
      `[0:v]fps=10,scale=${W}:${H}:flags=fast_bilinear:force_original_aspect_ratio=decrease:force_divisible_by=2,split[a][b];[a]pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1[a1];[b]scale=${W}:${H}:flags=fast_bilinear:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[b1];[a1][b1]vstack,format=yuv420p[out]`,
      "-map",
      "[out]",
      "-threads",
      "1",
      "-nostats", "-stats_period", "1", "-progress", "pipe:3",
      "-f",
      "rawvideo",
      "pipe:1",
    ];
    let diagnostic = "", lastDecodedAt = 0;
    const p = launch(this.ffmpeg, args, (line) => {
      diagnostic += line
        .replaceAll(conf.url, "[source]")
        .replace(/(?:rtsp|https?):\/\/\S+/g, "[url]");
      // Preserve the initial cause as well as the final FFmpeg summary.
      if (diagnostic.length > 8192)
        diagnostic = diagnostic.slice(0, 4096) + "\n…\n" + diagnostic.slice(-4093);
      s.error = diagnostic;
    });
    s.process = p;
    s.startedAt = Date.now();
    s.lagMs = 0;
    const clock = new LiveClock();
    let recovering = false;
    p.stdio[3].on("data", readProgress((values) => {
      if (this.closing || s.process !== p || recovering || !values.out_time_us || Number(values.frame) <= 0) return;
      const expired = clock.update(Number(values.out_time_us), Date.now());
      s.lagMs = Math.round(clock.lagMs);
      if (expired) {
        recovering = true;
        s.state = "recovering";
        s.recoveries = (s.recoveries || 0) + 1;
        s.lastRecovery = `Накопилось отставание видео ${Math.round(s.lagMs / 1000)} с. Переподключение источника.`;
        s.error = s.lastRecovery;
        this.log?.("source-lag", s.id + ": " + s.lastRecovery);
        p.kill("SIGKILL");
      }
    }));
    let buf = Buffer.alloc(FRAME),
      filled = 0;
    s.state = "connecting";
    p.stdout.on("data", (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const n = Math.min(FRAME - filled, chunk.length - offset);
        chunk.copy(buf, filled, offset, offset + n);
        offset += n;
        filled += n;
        if (filled === FRAME) {
          if (recovering) { filled = 0; continue; }
          const plane = W * H,
            quarter = plane / 4;
          s.frame = Buffer.concat([
            buf.subarray(0, plane),
            buf.subarray(plane * 2, plane * 2 + quarter),
            buf.subarray(plane * 2 + quarter * 2, plane * 2 + quarter * 3),
          ]);
          s.cover = Buffer.concat([
            buf.subarray(plane, plane * 2),
            buf.subarray(plane * 2 + quarter, plane * 2 + quarter * 2),
            buf.subarray(plane * 2 + quarter * 3),
          ]);
          s.lastFrame = lastDecodedAt = Date.now();
          s.state = recovering ? "recovering" : "online";
          s.retryAttempt = 0;
          if (!recovering) s.error = "";
          buf = Buffer.allocUnsafe(FRAME);
          filled = 0;
        }
      }
    });
    const started = Date.now();
    const watch = setInterval(() => {
      // Old display frames belong to the previous connection. Give each new
      // decoder its own startup window, then monitor only its received frames.
      const limit = lastDecodedAt ? 15000 : 45000;
      if (Date.now() - (lastDecodedAt || started) > limit) {
        s.error = diagnostic || (lastDecodedAt
          ? "Поток перестал передавать кадры: время ожидания истекло."
          : "Не получен первый видеокадр: время ожидания истекло.");
        p.kill("SIGKILL");
      }
    }, 3000);
    p.once("close", () => {
      clearInterval(watch);
      if (s.process !== p) return;
      s.process = null;
      s.state = "offline";
      if (this.sources.has(s.id) && !this.closing) this.scheduleDecode(s);
    });
  }
  scheduleDecode(s) {
    if (this.closing || !this.sources.has(s.id) || s.retry) return;
    s.retryAttempt = Math.min(8, (s.retryAttempt || 0) + 1);
    const delay = Math.min(15000, 1500 * s.retryAttempt) + Math.floor(Math.random() * 1000);
    s.state = "connecting";
    s.retry = setTimeout(() => {
      s.retry = null;
      if (this.closing || !this.sources.has(s.id)) return;
      try { this.decode(s, this.getSource(s.id)); }
      catch (error) {
        s.error = String(error?.message || error).slice(-500);
        s.state = "offline";
        this.scheduleDecode(s);
      }
    }, delay);
  }
  async restartSource(id) {
    const s = this.sources.get(id);
    if (!s) return;
    clearTimeout(s.retry);
    s.retry = null;
    await terminate(s.process);
    clearTimeout(s.retry);
    s.retry = null;
    s.process = null;
    s.lastFrame = 0;
    s.retryAttempt = 0;
    this.decode(s, this.getSource(id));
  }
  audio(s) {
    if (this.closing || s.audioRefs <= 0) return;
    const conf = this.getSource(s.id);
    if (conf.enabled === 0 || conf.enabled === false) return;
    const input = conf.url.startsWith("rtsp:")
      ? ["-rtsp_transport", conf.transport === "udp" ? "udp" : "tcp", "-timeout", "5000000"]
      : [
          "-rw_timeout",
          "5000000",
          "-protocol_whitelist",
          "http,https,tcp,tls,crypto",
        ];
    const p = launch(
      this.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-re",
        "-analyzeduration",
        "1000000",
        ...input,
        "-i",
        conf.url,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-flush_packets",
        "1",
        "-f",
        "s16le",
        "pipe:1",
      ],
      (line) => {
        s.audioError = line
          .replace(/(?:rtsp|https?):\/\/\S+/g, "[url]")
          .slice(-500);
      },
    );
    s.audioProcess = p;
    let pending = Buffer.alloc(0),
      last = Date.now();
    p.stdout.on("data", (chunk) => {
      last = Date.now();
      s.lastAudio = last;
      s.audioError = "";
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 3840) {
        const frame = Buffer.from(pending.subarray(0, 3840));
        pending = pending.subarray(3840);
        for (const q of s.audioClients) {
          if (q.length >= 10) q.shift();
          q.push(frame);
        }
      }
    });
    const watch = setInterval(() => {
      if (Date.now() - last > 12000) p.kill("SIGKILL");
    }, 3000);
    p.once("close", () => {
      clearInterval(watch);
      s.audioProcess = null;
      if (s.audioRefs > 0 && !this.closing)
        s.audioRetry = setTimeout(() => this.audio(s), 5000);
    });
  }
  async start(config, publish) {
    if (this.channels.has(config.id)) return;
    const ids = [
      ...new Set([...config.slots, ...(config.backups || []), config.audioSource].filter(Boolean)),
    ];
    ids.forEach((id) => this.source(id).refs++);
    if (config.audioSource) {
      const a = this.sources.get(config.audioSource);
      if (a.audioRefs++ === 0) this.audio(a);
    }
    const c = {
      encoder: config.encoder || "libx264",
      fallback: null,
      id: config.id,
      config,
      publish,
      ids,
      process: null,
      state: "starting",
      error: "",
      retry: null,
      startedAt: null,
      metrics: { fps: 0, bitrateKbps: 0, speed: 0, frame: 0, updatedAt: 0 },
      restarts: 0,
      lastErrorAt: null,
    };
    this.channels.set(c.id, c);
    this.encode(c);
  }
  encode(c) {
    if (this.closing || !this.channels.has(c.id)) return;
    const { config } = c;
    const [ow, oh] =
      config.quality === "1080p"
        ? [1920, 1080]
        : config.quality === "360p"
          ? [640, 360]
          : [1280, 720];
    const n = config.size,
      rects = canvasRects(config, ow, oh);
    const args = [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-nostdin",
      "-filter_complex_threads",
      "1",
    ];
    let inputs = 0,
      filters = [],
      labels = [];
    for (let i = 0; i < n; i++) {
      const { w: cw, h: ch } = rects[i];
      const id = config.slots[i];
      if (id) {
        const { w: W, h: H } = this.sources.get(id);
        args.push(
          "-thread_queue_size",
          "4",
          "-analyzeduration",
          "0",
          "-probesize",
          "32",
          "-f",
          "rawvideo",
          "-pixel_format",
          "yuv420p",
          "-video_size",
          `${W}x${H}`,
          "-framerate",
          String(config.fps),
          "-i",
          `http://127.0.0.1:${this.rawPort}/${id}?fps=${config.fps}&fit=${config.fits?.[i] || "cover"}&backup=${config.backups?.[i] || ""}&delay=${config.fallbackDelay || 5}&key=${this.token}`,
        );
        filters.push(
          `[${inputs++}:v]setpts=PTS-STARTPTS,scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2[v${i}]`,
        );
      } else
        filters.push(`color=c=0x161f26:s=${cw}x${ch}:r=${config.fps}[v${i}]`);
      labels.push(`[v${i}]`);
    }
    if (config.geometry) {
      filters.push(`color=c=0x161f26:s=${ow}x${oh}:r=${config.fps}[base]`);
      let last = "base";
      for (let i = 0; i < n; i++) {
        const next = `layer${i}`;
        filters.push(
          `[${last}][v${i}]overlay=${rects[i].x}:${rects[i].y}:shortest=1[${next}]`,
        );
        last = next;
      }
      filters.push(`[${last}]null[scene]`);
    } else if (n === 1) filters.push("[v0]null[scene]");
    else
      filters.push(
        `${labels.join("")}xstack=inputs=${n}:layout=${rects.map((r) => `${r.x}_${r.y}`).join("|")}:fill=black,scale=${ow}:${oh}[scene]`,
      );
    const esc = (s) =>
      String(s || "")
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/:/g, "\\:")
        .replace(/%/g, "\\%");
    let visual = "scene";
    for (let i = 0; i < n; i++)
      if (config.captions?.[i]) {
        const next = `cap${i}`,
          style = config.captionStyles?.[i] || {},
          position = style.position || "bottom-left",
          horizontal = position.split("-")[1],
          vertical = position.split("-")[0],
          r = rects[i],
          x = horizontal === "center"
            ? `${r.x}+(${r.w}-text_w)/2`
            : horizontal === "right"
              ? `${r.x + r.w}-text_w-12`
              : `${r.x + 12}`,
          y = vertical === "top" ? `${r.y + 12}` : `${r.y + r.h}-text_h-12`,
          fontSize = style.size === "large"
            ? Math.max(20, Math.round(ow / 48))
            : style.size === "small"
              ? Math.max(13, Math.round(ow / 82))
              : Math.max(16, Math.round(ow / 64)),
          box = style.background === false ? "" : ":box=1:boxcolor=black@0.58:boxborderw=7";
        filters.push(
          `[${visual}]drawtext=${this.fontOption()}text='${esc(config.captions[i])}':x=${x}:y=${y}:fontsize=${fontSize}:fontcolor=white:borderw=1:bordercolor=black${box}[${next}]`,
        );
        visual = next;
      }
    if (config.graphics?.title) {
      filters.push(
        `[${visual}]drawtext=${this.fontOption()}text='${esc(config.graphics.title)}':x=(w-text_w)/2:y=18:fontsize=${Math.max(20, Math.round(ow / 45))}:fontcolor=white:borderw=2:bordercolor=black[title]`,
      );
      visual = "title";
    }
    if (config.graphics?.clock) {
      filters.push(
        `[${visual}]drawtext=${this.fontOption()}text='%{localtime\\:%T}':x=w-text_w-24:y=18:fontsize=${Math.max(18, Math.round(ow / 55))}:fontcolor=white:borderw=2:bordercolor=black[clock]`,
      );
      visual = "clock";
    }
    if (config.graphics?.logoId) {
      const g = config.graphics,
        li = inputs++;
      args.push("-loop", "1", "-i", path.join(this.workDir, g.logoId + ".png"));
      const lw = Math.max(2, Math.round((ow * g.width) / 100)),
        lh = Math.max(2, Math.round((oh * g.height) / 100));
      filters.push(
        `[${li}:v]scale=${lw}:${lh}:force_original_aspect_ratio=decrease[logo]`,
      );
      filters.push(
        `[${visual}][logo]overlay=${Math.round((ow * g.x) / 100)}:${Math.round((oh * g.y) / 100)}:shortest=1[out]`,
      );
    } else filters.push(`[${visual}]null[out]`);
    let audioIndex = null;
    if (config.audioSource) {
      audioIndex = inputs;
      args.push(
        "-thread_queue_size",
        "32",
        "-analyzeduration",
        "0",
        "-probesize",
        "32",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        `http://127.0.0.1:${this.rawPort}/${config.audioSource}?audio=1&key=${this.token}`,
      );
    }
    args.push("-filter_complex", filters.join(";"), "-map", "[out]");
    if (audioIndex !== null)
      args.push("-map", `${audioIndex}:a`, "-c:a", "aac", "-b:a", "128k");
    else args.push("-an");
    args.push(
      "-c:v",
      c.encoder,
      ...(c.encoder === "libx264"
        ? ["-preset", "ultrafast", "-tune", "zerolatency"]
        : c.encoder === "h264_nvenc"
          ? ["-preset", "p4", "-tune", "ll"]
          : ["-preset", "veryfast"]),
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-b:v",
      `${config.bitrate || 2000}k`,
      "-maxrate",
      `${config.bitrate || 2000}k`,
      "-bufsize",
      `${(config.bitrate || 2000) * 2}k`,
      "-g",
      String(config.fps),
      "-keyint_min",
      String(config.fps),
      "-sc_threshold",
      "0",
      "-progress",
      "pipe:1",
      "-f",
      "rtsp",
      "-rtsp_transport",
      "tcp",
      c.publish,
    );
    c.state = "starting";
    const p = launch(this.ffmpeg, args, (line) => {
      c.error = line.replace(/(?:rtsp|https?):\/\/\S+/g, "[url]").slice(-700);
    });
    c.process = p;
    let lastProgress = Date.now(),
      progressBuffer = "";
    p.stdout.on("data", (b) => {
      progressBuffer += String(b);
      const blocks = progressBuffer.split(/progress=(?:continue|end)\r?\n/);
      progressBuffer = blocks.pop();
      for (const block of blocks) {
        const values = Object.fromEntries(
          block
            .trim()
            .split(/\r?\n/)
            .map((line) => {
              const i = line.indexOf("=");
              return i > 0 ? [line.slice(0, i), line.slice(i + 1)] : [line, ""];
            }),
        );
        if (Number(values.frame) > 0) {
          lastProgress = Date.now();
          c.state = "encoding";
          c.startedAt ??= Date.now();
          c.metrics = {
            frame: Number(values.frame) || 0,
            fps: Number(values.fps) || 0,
            bitrateKbps: Number.parseFloat(values.bitrate) || 0,
            speed: Number.parseFloat(values.speed) || 0,
            updatedAt: Date.now(),
          };
        }
      }
    });
    const watch = setInterval(() => {
      if (Date.now() - lastProgress > 20000) p.kill("SIGKILL");
    }, 5000);
    p.once("close", () => {
      clearInterval(watch);
      c.process = null;
      c.state = "error";
      c.restarts++;
      c.lastErrorAt = Date.now();
      if (c.error) this.log("encoder", c.id + ": " + c.error);
      if (this.channels.has(c.id) && !this.closing && c.encoder !== "libx264") {
        c.fallback =
          "Переход на CPU: " +
          (c.error.trim() || "аппаратный кодировщик завершился без публикации");
        this.log("encoder", c.fallback);
        c.encoder = "libx264";
      }
      if (this.channels.has(c.id) && !this.closing)
        c.retry = setTimeout(() => this.encode(c), 3000);
    });
  }
  async stop(id) {
    const c = this.channels.get(id);
    if (!c) return;
    this.channels.delete(id);
    clearTimeout(c.retry);
    await terminate(c.process);
    if (c.config.audioSource) {
      const a = this.sources.get(c.config.audioSource);
      if (a && --a.audioRefs <= 0) {
        clearTimeout(a.audioRetry);
        await terminate(a.audioProcess);
      }
    }
    for (const sid of c.ids) {
      const s = this.sources.get(sid);
      if (s && --s.refs <= 0) {
        this.sources.delete(sid);
        clearTimeout(s.retry);
        await terminate(s.process);
        clearTimeout(s.audioRetry);
        await terminate(s.audioProcess);
      }
    }
  }
  status() {
    return {
      sources: [...this.sources.values()].map((s) => ({
        id: s.id,
        pid: s.process?.pid || null,
        audioReady: Date.now() - s.lastAudio < 3000,
        audioError: s.audioError,
        status:
          s.state === "recovering" ? "recovering" : s.state === "online" && Date.now() - s.lastFrame < 4000
            ? "online"
            : s.state === "online"
              ? "offline"
              : s.state,
        error: s.error,
        lagMs: s.lagMs || 0,
        recoveries: s.recoveries || 0,
        lastRecovery: s.lastRecovery || "",
      })),
      channels: [...this.channels.values()].map((c) => ({
        id: c.id,
        encoder: c.encoder,
        fallback: c.fallback,
        status: c.state,
        error: c.error,
        startedAt: c.startedAt,
        pid: c.process?.pid || null,
        metrics: c.metrics,
        restarts: c.restarts,
        lastErrorAt: c.lastErrorAt,
      })),
    };
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.channels.keys()].map((id) => this.stop(id)));
    this.rawServer.closeAllConnections();
    await new Promise((ok) => this.rawServer.close(ok));
  }
}
module.exports = { Engine, terminate };
