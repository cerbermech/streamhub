"use strict";
const http = require("node:http"),
  net = require("node:net"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { spawn, spawnSync } = require("node:child_process"),
  { DatabaseSync } = require("node:sqlite");
const { Engine, terminate } = require("./engine.cjs");
const { countViewers } = require("./viewer-count.cjs");
const { validateScene } = require("./scene.cjs");
const { Diagnostics, explainError, run } = require("./diagnostics.cjs");
const { OnvifManager, cleanError: cleanOnvifError } = require("./onvif.cjs");
const QRCode = require("qrcode");
const { BackupManager, applyPending } = require("./backup.cjs");
const { RecordingManager } = require("./recording.cjs");
const {
  validateAutomation,
  scheduleShouldRun,
  nextBoundary,
} = require("./scheduler.cjs");
const os = require("node:os");
function networkAddresses() {
  try {
    return Object.entries(os.networkInterfaces()).flatMap(([name, items]) =>
      items
        .filter((a) => a.family === "IPv4" && !a.internal)
        .map((a) => ({ name, address: a.address })),
    );
  } catch {
    return [];
  }
}
function checkTcp(host, port, timeout = 1800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok, error = "") => {
      socket.destroy();
      resolve({ ok, error });
    };
    socket.setTimeout(timeout, () => finish(false, "Тайм-аут"));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, error.code || error.message));
  });
}
function requestWindowsFirewall(httpPort, rtspPort, log) {
  if (process.platform !== "win32") return false;
  const ports = [httpPort, rtspPort].map(Number);
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535))
    return false;
  const rule = `Videowall LAN ${ports.join("-")}`,
    args = `advfirewall firewall add rule name="${rule}" dir=in action=allow protocol=TCP localport=${ports.join(",")} profile=any`;
  try {
    const p = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-Command",
        `Start-Process -FilePath netsh.exe -Verb RunAs -ArgumentList '${args.replaceAll("'", "''")}' -Wait`,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    p.unref();
    return true;
  } catch (e) {
    log("firewall", e.message);
    return false;
  }
}
const idPattern = /^[a-zA-Z0-9_-]{1,80}$/;
function resolveBin(name) {
  const ext = process.platform === "win32" ? ".exe" : "";
  // Under ELECTRON_RUN_AS_NODE, used by the Windows service, resourcesPath can
  // be absent and __dirname points to resources/app.asar.
  const resourcesDir =
    process.resourcesPath ||
    (process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "resources")
      : path.dirname(__dirname));
  return (
    process.env[name.toUpperCase() + "_PATH"] ||
    [
      path.join(resourcesDir, "bin", name + ext),
      path.join(__dirname, "bin", name + ext),
    ].find((p) => fs.existsSync(p)) ||
    name
  );
}
async function startServer(options = {}) {
  const dir =
    options.dataDir ||
    process.env.VIDEOWALL_DATA ||
    path.join(__dirname, "data");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  applyPending(dir);
  const renderDir = path.join(dir, "graphics");
  fs.mkdirSync(renderDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, "wall.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL); CREATE TABLE IF NOT EXISTS channels(id TEXT PRIMARY KEY,config TEXT NOT NULL,desired INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS drafts(channel_id TEXT PRIMARY KEY,config TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,base_config TEXT NOT NULL);",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,severity TEXT NOT NULL,type TEXT NOT NULL,message TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0)",
  );
  if (
    !db
      .prepare("PRAGMA table_info(sources)")
      .all()
      .some((c) => c.name === "quality")
  )
    db.exec(
      "ALTER TABLE sources ADD COLUMN quality TEXT NOT NULL DEFAULT '360p'",
    );
  const sourceColumns = new Set(db.prepare("PRAGMA table_info(sources)").all().map((c) => c.name));
  if (!sourceColumns.has("description")) db.exec("ALTER TABLE sources ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  if (!sourceColumns.has("transport")) db.exec("ALTER TABLE sources ADD COLUMN transport TEXT NOT NULL DEFAULT 'tcp'");
  if (!sourceColumns.has("enabled")) db.exec("ALTER TABLE sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  const get = (k) => {
      const v = db.prepare("SELECT value FROM settings WHERE key=?").get(k);
      return v ? JSON.parse(v.value) : null;
    },
    set = (k, v) =>
      db
        .prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
        .run(k, JSON.stringify(v));

  // Keep public names independent of internal IDs and display names.
  db.exec(
    "CREATE TABLE IF NOT EXISTS channel_names (slug TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE)",
  );
  const nextSlug = () => {
    let n = 1;
    while (
      db.prepare("SELECT 1 FROM channel_names WHERE slug=?").get("kanal-" + n)
    )
      n++;
    return "kanal-" + n;
  };
  db.exec("BEGIN");
  try {
    for (const row of db.prepare("SELECT * FROM channels").all()) {
      const c = JSON.parse(row.config);
      let entry = db
        .prepare("SELECT slug FROM channel_names WHERE channel_id=?")
        .get(row.id);
      if (!entry) {
        entry = { slug: nextSlug() };
        db.prepare("INSERT INTO channel_names VALUES(?,?)").run(
          entry.slug,
          row.id,
        );
      }
      c.slug = entry.slug;
      c.fits ??= Array(c.size).fill("cover");
      db.prepare("UPDATE channels SET config=? WHERE id=?").run(
        JSON.stringify(c),
        row.id,
      );
    }
    set(
      "layouts",
      (get("layouts") || []).map((l) => ({
        ...l,
        id: l.id || crypto.randomUUID(),
        fits: l.fits || Array(l.size).fill("cover"),
      })),
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const validFits = (fits, size) => {
    if (fits === undefined) return Array(size).fill("cover");
    if (
      !Array.isArray(fits) ||
      fits.length !== size ||
      fits.some((f) => !["contain", "cover"].includes(f))
    )
      throw Error("Неверный режим заполнения ячеек");
    return fits;
  };
  const validateSlug = (value) => {
    const slug = value?.trim() || nextSlug();
    if (
      !/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug) ||
      slug.startsWith("channel-") ||
      slug === "all-others"
    )
      throw Error("Адрес: до 48 латинских строчных букв, цифр и дефисов");
    if (db.prepare("SELECT 1 FROM channel_names WHERE slug=?").get(slug))
      throw Error("Этот адрес уже занят");
    return slug;
  };
  let credentials = get("credentials");
  if (!credentials) {
    credentials = {
      admin:
        process.env.VIDEOWALL_PASSWORD ||
        crypto.randomBytes(18).toString("base64url"),
      viewer: crypto.randomBytes(18).toString("base64url"),
    };
    set("credentials", credentials);
    fs.writeFileSync(
      path.join(dir, "first-login.txt"),
      `Администратор: admin\nПароль: ${credentials.admin}\nЗритель: viewer\nПароль: ${credentials.viewer}\n`,
      { mode: 0o600 },
    );
  }
  const desktopTokenFile = path.join(dir, "desktop.token");
  if (!fs.existsSync(desktopTokenFile))
    fs.writeFileSync(desktopTokenFile, crypto.randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
  const desktopToken = fs.readFileSync(desktopTokenFile, "utf8").trim();
  const keyFile = path.join(dir, "secret.key");
  if (!fs.existsSync(keyFile))
    fs.writeFileSync(keyFile, crypto.randomBytes(32), { mode: 0o600 });
  const key = fs.readFileSync(keyFile);
  const encrypt = (s) => {
    const iv = crypto.randomBytes(12),
      c = crypto.createCipheriv("aes-256-gcm", key, iv);
    return Buffer.concat([iv, c.update(s), c.final(), c.getAuthTag()]).toString(
      "base64",
    );
  };
  const decrypt = (s) => {
    const b = Buffer.from(s, "base64"),
      c = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(-16));
    return Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString();
  };
  db.exec(
    "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,session_version INTEGER NOT NULL DEFAULT 1,vlc_secret TEXT NOT NULL,created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS user_channels(user_id TEXT NOT NULL,channel_id TEXT NOT NULL,PRIMARY KEY(user_id,channel_id)); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,user_id TEXT,username TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,ip TEXT NOT NULL,details TEXT NOT NULL)",
  );
  const hashPassword = (
    password,
    salt = crypto.randomBytes(16).toString("hex"),
  ) =>
    `${salt}:${crypto.scryptSync(String(password), salt, 32).toString("hex")}`;
  const verifyPassword = (password, stored) => {
    try {
      const [salt, want] = stored.split(":"),
        got = crypto.scryptSync(String(password), salt, 32);
      return crypto.timingSafeEqual(got, Buffer.from(want, "hex"));
    } catch {
      return false;
    }
  };
  if (!db.prepare("SELECT 1 FROM users LIMIT 1").get()) {
    const now = new Date().toISOString();
    for (const [username, roleName] of [
      ["admin", "admin"],
      ["viewer", "viewer"],
    ])
      db.prepare("INSERT INTO users VALUES(?,?,?,?,1,1,?,?)").run(
        crypto.randomUUID(),
        username,
        hashPassword(credentials[username]),
        roleName,
        encrypt(credentials[username]),
        now,
      );
    const legacyViewer = db
      .prepare("SELECT id FROM users WHERE username='viewer'")
      .get();
    for (const channel of db.prepare("SELECT id FROM channels").all())
      db.prepare("INSERT OR IGNORE INTO user_channels VALUES(?,?)").run(
        legacyViewer.id,
        channel.id,
      );
    set("legacyViewerAutoAssign", true);
  }
  const publicUser = (row) => ({
    id: row.id,
    username: row.username,
    role: row.role,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    channels: db
      .prepare("SELECT channel_id FROM user_channels WHERE user_id=?")
      .all(row.id)
      .map((x) => x.channel_id),
  });
  const source = (id) => {
    const s = db.prepare("SELECT * FROM sources WHERE id=?").get(id);
    return s ? { ...s, url: decrypt(s.url) } : null;
  };
  const captureInfo = (href) => {
    const u = new URL(href);
    if (!['screen:', 'window:', 'dshow:'].includes(u.protocol)) return null;
    return {
      kind: u.protocol === 'screen:' ? 'screen' : u.protocol === 'window:' ? 'window' : 'device',
      target: u.searchParams.get('target') || u.hostname || '',
      fps: Number(u.searchParams.get('fps') || 25),
      width: Number(u.searchParams.get('width') || 1280),
      height: Number(u.searchParams.get('height') || 720),
      x: Number(u.searchParams.get('x') || 0),
      y: Number(u.searchParams.get('y') || 0),
      cursor: u.searchParams.get('cursor') !== '0',
      format: u.searchParams.get('format') || 'auto',
    };
  };
  const captureUrl = (b) => {
    const type = b.type === 'screen' ? 'screen' : b.type === 'window' ? 'window' : b.type === 'device' ? 'dshow' : null;
    if (!type) return null;
    const target = String(b.target || '').trim();
    if (!target || target.length > 300) throw Error('Выберите устройство или монитор');
    const fps = Number(b.fps || 25), width = Number(b.width || 1280), height = Number(b.height || 720);
    if (![10,15,25,30,50,60].includes(fps) || !Number.isInteger(width) || !Number.isInteger(height) || width < 160 || height < 120 || width > 7680 || height > 4320) throw Error('Неверные параметры захвата');
    const u = new URL(`${type}://capture`);
    u.searchParams.set('target',target);
    for (const [key,value] of Object.entries({fps,width,height,x:Number(b.x||0),y:Number(b.y||0),cursor:b.cursor===false||b.cursor==='false'?'0':'1',format:String(b.format||'auto')})) u.searchParams.set(key,String(value));
    return u;
  };
  const onvif = new OnvifManager();
  const onvifConfig = (id) => {
    const stored = (get("onvifSources") || {})[id];
    if (!stored) return null;
    return {
      ...stored,
      password: stored.password ? decrypt(stored.password) : "",
    };
  };
  const saveOnvifConfig = (id, config) => {
    const all = get("onvifSources") || {};
    all[id] = {
      host: config.host,
      port: Number(config.port || 80),
      path: config.path || "/onvif/device_service",
      username: config.username || "",
      password: config.password ? encrypt(config.password) : "",
    };
    set("onvifSources", all);
  };
  const channel = (id) => {
    const row = db.prepare("SELECT * FROM channels WHERE id=?").get(id);
    return row ? JSON.parse(row.config) : null;
  };
  const messages = [];
  const log = (who, msg) => {
    messages.push({
      at: new Date().toISOString(),
      who,
      message: String(msg)
        .replace(/(?:rtsp|https?):\/\/\S+/g, "[url]")
        .slice(-1000),
    });
    if (messages.length > 100) messages.shift();
    if (
      [
        "encoder",
        "restore",
        "backup",
        "schedule",
        "source",
        "channel",
        "recording",
      ].includes(who)
    )
      try {
        db.prepare(
          "INSERT INTO events(created_at,severity,type,message) VALUES(?,?,?,?)",
        ).run(
          new Date().toISOString(),
          /ошиб|сбой|потер|error/i.test(String(msg)) ? "error" : "info",
          who,
          String(msg).slice(-1000),
        );
      } catch {}
  };
  const backupsManager = new BackupManager(dir, db, log);
  const scheduleOverrides = get("scheduleOverrides") || {};
  const ffmpeg = resolveBin("ffmpeg"),
    mtxBin = resolveBin("mediamtx");
  const deps = {
    ffmpeg:
      spawnSync(ffmpeg, ["-version"], { timeout: 5000, windowsHide: true })
        .status === 0,
    mediamtx:
      spawnSync(mtxBin, ["--version"], { timeout: 5000, windowsHide: true })
        .status === 0,
  };
  const encodersText = deps.ffmpeg
    ? spawnSync(ffmpeg, ["-encoders"], {
        encoding: "utf8",
        timeout: 5000,
        windowsHide: true,
      }).stdout || ""
    : "";
  const encoders = ["libx264", "h264_nvenc", "h264_qsv"].filter((e) =>
    encodersText.includes(e),
  );
  const port = Number(options.port ?? process.env.PORT ?? 8080),
    host =
      options.host ||
      process.env.VIDEOWALL_HOST ||
      (get("network")?.lan ? "0.0.0.0" : "127.0.0.1");
  const mtxApi = Number(process.env.MTX_API_PORT || 9997),
    rtspPort = Number(process.env.MTX_RTSP_PORT || 8554),
    hlsPort = Number(process.env.MTX_HLS_PORT || 8888);
  const recordings = new RecordingManager({
    dir,
    ffmpeg,
    getSource: (id) => { const s=source(id); return s&&captureInfo(s.url)?{...s,url:`rtsp://127.0.0.1:${rtspPort}/capture-${id}`} : s; },
    getChannel: channel,
    getSettings: () => get("recording"),
    setSettings: (v) => set("recording", v),
    log,
    rtspPort,
  });
  const mediaConfig = {
    logLevel: "warn",
    api: true,
    apiAddress: `127.0.0.1:${mtxApi}`,
    rtspAddress: `${host}:${rtspPort}`,
    rtspTransports: ["tcp"],
    rtmp: false,
    srt: false,
    webrtc: false,
    moq: false,
    hls: true,
    hlsAddress: `127.0.0.1:${hlsPort}`,
    hlsVariant: "mpegts",
    hlsSegmentCount: 3,
    hlsSegmentDuration: "1s",
    hlsAlwaysRemux: true,
    hlsMuxerCloseAfter: "10s",
    authInternalUsers: [
      {
        user: "any",
        ips: ["127.0.0.1", "::1"],
        permissions: [
          { action: "publish" },
          { action: "read" },
          { action: "api" },
        ],
      },
    ],
    paths: { all_others: {} },
  };
  const configFile = path.join(dir, "mediamtx.json");
  function syncAliases() {
    mediaConfig.paths = { all_others: {} };
    for (const { slug, channel_id } of db
      .prepare("SELECT * FROM channel_names")
      .all())
      mediaConfig.paths[slug] = {
        source: `rtsp://127.0.0.1:${rtspPort}/channel-${channel_id}`,
        sourceOnDemand: true,
        rtspTransport: "tcp",
      };
    mediaConfig.authInternalUsers = mediaConfig.authInternalUsers.slice(0, 1);
    for (const user of db
      .prepare("SELECT * FROM users WHERE enabled=1")
      .all()) {
      const assigned = new Set(
        db
          .prepare("SELECT channel_id FROM user_channels WHERE user_id=?")
          .all(user.id)
          .map((x) => x.channel_id),
      );
      const permissions =
        user.role === "admin"
          ? [{ action: "read" }]
          : db
              .prepare("SELECT * FROM channel_names")
              .all()
              .filter((x) => assigned.has(x.channel_id))
              .map((x) => ({ action: "read", path: x.slug }));
      mediaConfig.authInternalUsers.push({
        user: user.username,
        pass: decrypt(user.vlc_secret),
        permissions: permissions.length
          ? permissions
          : [{ action: "read", path: "__no_channel__" }],
      });
    }
    fs.writeFileSync(configFile, JSON.stringify(mediaConfig), { mode: 0o600 });
  }
  syncAliases();
  let mtx = null,
    mtxTimer,
    closing = false,
    mediaReady = false,
    paths = new Set(),
    readersByPath = new Map();
  function runMTX() {
    if (!deps.mediamtx || closing) return;
    mtx = spawn(mtxBin, [configFile], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    mtx.stdout.on("data", (s) => log("MediaMTX", s));
    mtx.stderr.on("data", (s) => log("MediaMTX", s));
    mtx.on("error", (e) => log("MediaMTX", e.message));
    mtx.on("close", () => {
      mediaReady = false;
      paths.clear();
      readersByPath.clear();
      if (!closing) mtxTimer = setTimeout(runMTX, 3000);
    });
  }
  runMTX();
  const engine = new Engine({
    ffmpeg,
    getSource: (id) => { const s=source(id); return s&&captureInfo(s.url)?{...s,url:`rtsp://127.0.0.1:${rtspPort}/capture-${id}`} : s; },
    log,
    workDir: renderDir,
  });
  await engine.init();
  const diagnostics = new Diagnostics();
  diagnostics.start(() => [
    mtx?.pid,
    ...[...engine.sources.values()].flatMap((s) => [
      s.process?.pid,
      s.audioProcess?.pid,
    ]),
    ...[...engine.channels.values()].map((c) => c.process?.pid),
  ]);
  const streamName = (id) => "channel-" + id;
  const startChannel = async (c) => {
    if (!deps.ffmpeg || !deps.mediamtx)
      throw Error("Установите FFmpeg и MediaMTX в папку bin");
    await engine.start(c, `rtsp://127.0.0.1:${rtspPort}/${streamName(c.id)}`);
  };
  const waitReady = async (id, seconds = 25) => {
    for (let i = 0; i < seconds * 4; i++) {
      const c = engine.channels.get(id);
      if (c?.state === "encoding" && paths.has(streamName(id))) return;
      if (c?.state === "error" && c.error) throw Error(c.error);
      await new Promise((r) => setTimeout(r, 250));
    }
    throw Error("Поток не успел запуститься");
  };
  const poll = setInterval(async () => {
    try {
      const r = await fetch(
        `http://127.0.0.1:${mtxApi}/v3/paths/list?itemsPerPage=100000`,
        { signal: AbortSignal.timeout(1500) },
      );
      if (!r.ok) throw Error("API");
      const j = await r.json();
      mediaReady = true;
      paths = new Set(j.items.filter((p) => p.ready).map((p) => p.name));
      readersByPath = new Map(j.items.map((p) => [p.name, Array.isArray(p.readers) ? p.readers : []]));
    } catch {
      mediaReady = false;
      paths.clear();
      readersByPath.clear();
    }
  }, 1000);
  const sessions = new Map(),
    attempts = new Map(),
    previewLeases = new Map();
  let captureInventory = { displays: [], windows: [], devices: [], updatedAt: 0 };
  const captureStatuses = new Map();
  const monitoring = new Map();
  // One sample per completed camera check. Retain seven days of history.
  db.exec("CREATE TABLE IF NOT EXISTS monitor_history (source_id TEXT NOT NULL, checked_at INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', PRIMARY KEY(source_id, checked_at)); CREATE INDEX IF NOT EXISTS monitor_history_time ON monitor_history(checked_at)");
  const pingHost = (host, timeout = 1800) => new Promise((resolve) => {
    if (!host) return resolve({ ok: false, error: "Адрес не указан" });
    const args = process.platform === "win32"
      ? ["-n", "1", "-w", String(timeout), host]
      : ["-c", "1", "-W", String(Math.max(1, Math.ceil(timeout / 1000))), host];
    let done = false, timer;
    const finish = (ok, error = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, error });
    };
    let child;
    try {
      child = spawn("ping", args, { windowsHide: true, stdio: "ignore" });
    } catch (error) {
      return finish(false, error.message);
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, "Тайм-аут ping");
    }, timeout + 700);
    child.once("error", (error) => finish(false, error.code || error.message));
    child.once("close", (code) => finish(code === 0, code === 0 ? "" : "Нет ответа на ping"));
  });
  const monitorOne = async (row) => {
    const current = source(row.id), capture = captureInfo(current.url), startedAt = Date.now();
    if (current.enabled === 0) return {id:row.id,name:row.name,kind:capture ? "capture" : "network",ok:false,ping:null,tcp:null,status:"disabled",reason:"Источник выключен",checkedAt:Date.now()};
    if (capture) {
      const agent = captureStatuses.get(row.id), ok = agent?.status === "online";
      return {
        id: row.id, name: row.name, kind: "capture", ok, ping: null, tcp: ok,
        status: ok ? "online" : agent?.status || "offline",
        reason: ok ? "" : agent?.error || "Агент захвата не передаёт видео",
        checkedAt: Date.now(), latencyMs: Date.now() - startedAt,
      };
    }
    let parsed;
    try { parsed = new URL(current.url); }
    catch { return { id: row.id, name: row.name, kind: "network", ok: false, ping: false, tcp: false, status: "offline", reason: "Неверный адрес", checkedAt: Date.now(), latencyMs: 0 }; }
    const port = Number(parsed.port || (parsed.protocol === "rtsp:" ? 554 : parsed.protocol === "https:" ? 443 : 80));
    const [ping, tcp] = await Promise.all([pingHost(parsed.hostname), checkTcp(parsed.hostname, port, 2200)]);
    const running = engine.status().sources.find((item) => item.id === row.id), streamFresh = running?.status === "online";
    const ok = streamFresh || tcp.ok;
    return {
      id: row.id, name: row.name, kind: parsed.protocol.replace(":", ""), host: parsed.hostname,
      port, ok, ping: ping.ok, tcp: tcp.ok, status: streamFresh ? "online" : ok ? "reachable" : "offline",
      reason: ok ? "" : tcp.error || ping.error || "Камера недоступна",
      checkedAt: Date.now(), latencyMs: Date.now() - startedAt,
    };
  };
  let monitorRunning = false;
  const refreshMonitoring = async () => {
    if (monitorRunning || closing) return;
    monitorRunning = true;
    try {
      const rows = db.prepare("SELECT id,name FROM sources ORDER BY name").all();
      const ids = new Set(rows.map((row) => row.id));
      for (const id of monitoring.keys()) if (!ids.has(id)) monitoring.delete(id);
      for (let offset = 0; offset < rows.length; offset += 8) {
        const results = await Promise.all(rows.slice(offset, offset + 8).map((row) => monitorOne(row)));
        for (const result of results) {
          monitoring.set(result.id, result);
          db.prepare("INSERT OR REPLACE INTO monitor_history(source_id,checked_at,status,reason) VALUES(?,?,?,?)")
            .run(result.id, result.checkedAt, result.status, result.reason || "");
        }
      }
      db.prepare("DELETE FROM monitor_history WHERE checked_at < ?").run(Date.now() - 7 * 86400000);
    } finally { monitorRunning = false; }
  };
  const safeEq = (a, b) => {
    const x = crypto.createHash("sha256").update(a).digest(),
      y = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(x, y);
  };
  function principal(q) {
    const remote = q.socket?.remoteAddress;
    if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) && typeof q.headers["x-desktop-token"] === "string" && safeEq(q.headers["x-desktop-token"], desktopToken)) {
      const admin = db.prepare("SELECT * FROM users WHERE username='admin' AND enabled=1").get();
      if (admin) return publicUser(admin);
    }
    const cookie = (q.headers.cookie || "").match(
      /(?:^|; )wall=([a-f0-9]+)/,
    )?.[1];
    const session = sessions.get(cookie);
    if (session && session.until > Date.now()) {
      const user = db
        .prepare("SELECT * FROM users WHERE id=? AND enabled=1")
        .get(session.userId);
      if (user && user.session_version === session.version)
        return publicUser(user);
    }
    if (session) sessions.delete(cookie);
    const a = q.headers.authorization;
    if (a?.startsWith("Basic ")) {
      const [user, ...rest] = Buffer.from(a.slice(6), "base64")
        .toString()
        .split(":");
      const row = db
        .prepare("SELECT * FROM users WHERE username=? AND enabled=1")
        .get(user);
      if (row && verifyPassword(rest.join(":"), row.password_hash))
        return publicUser(row);
    }
    return null;
  }
  const role = (q) => principal(q)?.role || null;
  const canAccess = (p, channelId) =>
    !!p && (p.role === "admin" || p.channels.includes(channelId));
  const audit = (q, p, action, target, details = {}) =>
    db
      .prepare(
        "INSERT INTO audit(created_at,user_id,username,action,target,ip,details) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        p?.id || null,
        p?.username || "system",
        action,
        String(target || ""),
        q?.socket?.remoteAddress || "local",
        JSON.stringify(details),
      );
  function json(r, status, data) {
    r.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    r.end(JSON.stringify(data));
  }
  function serveVideo(q, r, file, download = false) {
    const stat = fs.statSync(file),
      range = q.headers.range;
    if (download)
      r.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(file)}"`,
      );
    if (range) {
      const m = range.match(/^bytes=(\d*)-(\d*)$/);
      let start = 0, end = stat.size - 1;
      if (m?.[1]) start = Number(m[1]);
      if (m?.[2]) {
        if (m[1]) end = Math.min(Number(m[2]), stat.size - 1);
        else start = Math.max(0, stat.size - Number(m[2]));
      }
      if (!m || start > end || start >= stat.size) {
        r.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return r.end();
      }
      r.writeHead(206, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Content-Length": end - start + 1,
        "Cache-Control": "no-store",
      });
      return q.method === "HEAD" ? r.end() : fs.createReadStream(file, { start, end }).pipe(r);
    }
    r.writeHead(200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    if (q.method === "HEAD") return r.end();
    fs.createReadStream(file).pipe(r);
  }
  async function body(q, limit = 131072) {
    let chunks = [],
      n = 0;
    for await (const b of q) {
      n += b.length;
      if (n > limit) throw Error("Запрос слишком большой");
      chunks.push(b);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  }
  const logoExists = (id) => fs.existsSync(path.join(renderDir, id + ".png"));
  function validateChannel(c) {
    if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 80)
      throw Error("Укажите название");
    const custom = Array.isArray(c.geometry);
    if (
      (!custom && ![1, 4, 6, 8, 9, 16, 20, 25, 36, 49, 64].includes(c.size)) ||
      (custom && (!Number.isInteger(c.size) || c.size < 1 || c.size > 64)) ||
      !["360p", "720p", "1080p"].includes(c.quality) ||
      ![10, 15, 25].includes(c.fps)
    )
      throw Error("Неверные параметры канала");
    if (
      !Array.isArray(c.slots) ||
      c.slots.length !== c.size ||
      !c.slots.some(Boolean)
    )
      throw Error("Назначьте источники в раскладку");
    for (const id of c.slots)
      if (id && !source(id)) throw Error("Источник не найден");
    if (!Number.isInteger(c.bitrate) || c.bitrate < 200 || c.bitrate > 20000)
      throw Error("Битрейт от 200 до 20000 кбит/с");
    if (c.audioSource && !source(c.audioSource))
      throw Error("Источник звука не найден");
    if (c.encoder && !["libx264", "h264_nvenc", "h264_qsv"].includes(c.encoder))
      throw Error("Неверный кодировщик");
    const reserve = Array.isArray(c.backups) ? c.backups.slice(0, c.size) : [];
    while (reserve.length < c.size) reserve.push(null);
    for (let i = 0; i < reserve.length; i++)
      if (reserve[i] && (!source(reserve[i]) || reserve[i] === c.slots[i]))
        throw Error("Неверный резервный источник");
    return {
      fits: validFits(c.fits, c.size),
      audioSource: c.audioSource || null,
      encoder: c.encoder || "libx264",
      name: c.name.trim(),
      size: c.size,
      slots: c.slots,
      quality: c.quality,
      fps: c.fps,
      bitrate: c.bitrate,
      backups: reserve,
      fallbackDelay: Math.max(4, Math.min(60, Number(c.fallbackDelay) || 5)),
      automation: validateAutomation(c.automation),
      ...validateScene(c, logoExists),
    };
  }
  let mutations = Promise.resolve();
  const server = http.createServer(async (q, r) => {
    let unlock;
    try {
      const u = new URL(q.url, "http://localhost");
      const pathname = u.pathname;
      const actor = principal(q),
        access = actor?.role || null;
      if (pathname === "/api/health" && q.method === "GET")
        return json(r, 200, {
          ok: true,
          version: "1.6.5",
          serviceMode: !!options.serviceMode,
        });
      if (pathname === "/api/monitoring" && q.method === "GET" && access) {
        if (!monitorRunning && (!monitoring.size || [...monitoring.values()].some((item) => Date.now() - item.checkedAt > 20000)))
          refreshMonitoring().catch((error) => log("monitoring", error.message));
        const rows = db.prepare("SELECT id,name FROM sources ORDER BY name").all();
        return json(r, 200, {
          checkedAt: Math.max(0, ...[...monitoring.values()].map((item) => item.checkedAt || 0)),
          refreshing: monitorRunning,
          sources: rows.map((row) => monitoring.get(row.id) || {
            ...row, ok: false, ping: null, tcp: null, status: "checking", reason: "Проверка…", checkedAt: 0,
          }),
        });
      }
      const historyRoute = pathname.match(/^\/api\/monitoring\/([a-zA-Z0-9_-]+)\/history$/);
      if (historyRoute && q.method === "GET" && access) {
        if (!db.prepare("SELECT 1 FROM sources WHERE id=?").get(historyRoute[1])) return json(r, 404, { error: "Источник не найден" });
        return json(r, 200, { points: db.prepare("SELECT checked_at AS checkedAt,status,reason FROM monitor_history WHERE source_id=? AND checked_at>=? ORDER BY checked_at")
          .all(historyRoute[1], Date.now() - 86400000) });
      }
      if (access && !["GET", "HEAD"].includes(q.method)) {
        const previous = mutations;
        mutations = new Promise((resolve) => (unlock = resolve));
        await previous;
      }
      // Mutating browser requests must originate at this server. No permissive CORS.
      if (
        !["GET", "HEAD"].includes(q.method) &&
        q.headers.origin &&
        q.headers.origin !== `http://${q.headers.host}` &&
        q.headers.origin !== `https://${q.headers.host}`
      )
        return json(r, 403, { error: "Чужой origin" });
      if (pathname === "/api/login" && q.method === "POST") {
        const ip = q.socket.remoteAddress;
        let a = attempts.get(ip) || { n: 0, until: Date.now() + 60000 };
        if (a.until < Date.now()) a = { n: 0, until: Date.now() + 60000 };
        if (a.n >= 10) return json(r, 429, { error: "Подождите минуту" });
        a.n++;
        attempts.set(ip, a);
        const b = await body(q);
        const username = String(b.user || "admin")
            .trim()
            .toLowerCase(),
          userRow = db
            .prepare("SELECT * FROM users WHERE username=? AND enabled=1")
            .get(username);
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
        const bootstrapOk =
          local &&
          username === "admin" &&
          typeof b.bootstrap === "string" &&
          safeEq(b.bootstrap, desktopToken);
        if (
          !userRow ||
          (!bootstrapOk && !verifyPassword(b.password, userRow.password_hash))
        )
          return json(r, 401, { error: "Неверный пароль" });
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString("hex");
        sessions.set(token, {
          userId: userRow.id,
          version: userRow.session_version,
          until: Date.now() + 86400000,
          createdAt: Date.now(),
          ip,
          userAgent: String(q.headers["user-agent"] || "").slice(0, 200),
        });
        r.setHeader(
          "Set-Cookie",
          `wall=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        );
        audit(q, publicUser(userRow), "login", "session");
        return json(r, 200, { role: userRow.role, username: userRow.username });
      }
      if (pathname === "/api/logout" && q.method === "POST") {
        const token = (q.headers.cookie || "").match(/wall=([a-f0-9]+)/)?.[1];
        sessions.delete(token);
        r.setHeader(
          "Set-Cookie",
          "wall=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return json(r, 200, { ok: true });
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/live/")) {
        if (!access) {
          if (pathname.startsWith("/live/"))
            r.setHeader("WWW-Authenticate", 'Basic realm="Videowall"');
          return json(r, 401, { error: "Войдите в приложение" });
        }
      }
      if (pathname === "/api/qr" && q.method === "GET") {
        const text = String(u.searchParams.get("text") || "");
        if (text.length > 500 || !/^https?:\/\//.test(text))
          throw Error("Неверная ссылка");
        const png = await QRCode.toBuffer(text, {
          width: 280,
          margin: 2,
          errorCorrectionLevel: "M",
        });
        r.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
        });
        return r.end(png);
      }
      const watchState = pathname.match(/^\/api\/watch\/([a-z0-9-]{1,48})$/);
      if (watchState && q.method === "GET") {
        const row = db
          .prepare("SELECT c.* FROM channels c JOIN channel_names n ON n.channel_id=c.id WHERE n.slug=?")
          .get(watchState[1]);
        if (!row) return json(r, 404, { error: "Канал не найден" });
        if (!canAccess(actor, row.id)) return json(r, 403, { error: "Нет доступа к каналу" });
        const config = JSON.parse(row.config),
          runtime = engine.status().channels.find((item) => item.id === row.id),
          live = !!row.desired && runtime?.status === "encoding" && paths.has(streamName(row.id));
        return json(r, 200, {
          id: row.id,
          name: config.name,
          slug: config.slug,
          desired: !!row.desired,
          status: live ? "live" : runtime?.status || (row.desired ? "starting" : "stopped"),
          mediaReady,
          hls: `/live/${config.slug}/index.m3u8`,
        });
      }
      if (pathname === "/api/state" && q.method === "GET") {
        const status = engine.status(),
          diagnosticSnapshot = diagnostics.snapshot();
        return json(r, 200, {
          role: access,
          currentUser: actor,
          serviceMode: !!options.serviceMode,
          serverTime: Date.now(),
          serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          logos: access === "admin" ? get("logos") || [] : [],
          network: {
            lan: host === "0.0.0.0",
            nextLan: !!get("network")?.lan,
            pendingRestart: (host === "0.0.0.0") !== !!get("network")?.lan,
            bindAddress: host,
            publicHost: get("network")?.publicHost || "",
            port: server.address().port,
            rtspPort,
            addresses: networkAddresses(),
          },
          nextSlug: nextSlug(),
          encoders,
          dependencies: deps,
          mediaReady,
          backups: access === "admin" ? backupsManager.list() : [],
          archive: access === "admin" ? recordings.status() : null,
          events:
            access === "admin"
              ? db
                  .prepare("SELECT * FROM events ORDER BY id DESC LIMIT 100")
                  .all()
              : [],
          users:
            access === "admin"
              ? db
                  .prepare("SELECT * FROM users ORDER BY username")
                  .all()
                  .map(publicUser)
              : [],
          audit:
            access === "admin"
              ? db
                  .prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 200")
                  .all()
              : [],
          sessions:
            access === "admin"
              ? [...sessions.entries()].map(([token, s]) => ({
                  id: token.slice(0, 12),
                  userId: s.userId,
                  username:
                    db
                      .prepare("SELECT username FROM users WHERE id=?")
                      .get(s.userId)?.username || "?",
                  createdAt: s.createdAt,
                  until: s.until,
                  ip: s.ip,
                  userAgent: s.userAgent,
                }))
              : [],
          sources:
            access === "viewer"
              ? []
              : db
                  .prepare("SELECT id,name,quality,description,transport,enabled FROM sources")
                  .all()
                  .sort((a,b)=>{const order=get("sourceOrder")||[],ai=order.indexOf(a.id),bi=order.indexOf(b.id);return (ai<0?1e9:ai)-(bi<0?1e9:bi)||a.name.localeCompare(b.name,"ru")})
                  .map((s) => {
                    const original=source(s.id).url,
                      capture=captureInfo(original),
                      agent=capture?captureStatuses.get(s.id):null,
                      stored = new URL(original),
                      username = decodeURIComponent(stored.username || "");
                    stored.username = "";
                    stored.password = "";
                    return {
                    ...s,
                    ...(access === "admin"
                      ? { url: capture ? "" : stored.href, username, onvif: !capture && !!onvifConfig(s.id), capture }
                      : access === "operator"
                        ? { onvif: !capture && !!onvifConfig(s.id) }
                        : {}),
                    audioReady:
                      status.sources.find((a) => a.id === s.id)?.audioReady ||
                      false,
                    audioError:
                      status.sources.find((a) => a.id === s.id)?.audioError ||
                      "",
                    status:
                      (agent?.status==="offline"?"offline":status.sources.find((a) => a.id === s.id)?.status) ||
                      "idle",
                    error:
                      agent?.error || status.sources.find((a) => a.id === s.id)?.error || "",
                    reason: explainError(
                      agent?.error || status.sources.find((a) => a.id === s.id)?.error,
                    ),
                  }}),
          channels: db
            .prepare("SELECT * FROM channels")
            .all()
            .sort((a,b)=>{const order=get("channelOrder")||[],ai=order.indexOf(a.id),bi=order.indexOf(b.id);return (ai<0?1e9:ai)-(bi<0?1e9:bi)})
            .filter((row) => canAccess(actor, row.id))
            .map((row) => {
              const c = JSON.parse(row.config),
                run = status.channels.find((a) => a.id === row.id);
              return {
                ...c,
                desired: !!row.desired,
                effectiveEncoder: run?.encoder || c.encoder || "libx264",
                fallback: run?.fallback || null,
                status: !row.desired
                  ? "stopped"
                  : run?.status === "encoding" && paths.has(streamName(c.id))
                    ? "live"
                    : run?.status || "starting",
                error: run?.error || "",
                reason: explainError(run?.fallback || run?.error),
                uptimeMs: run?.startedAt ? Date.now() - run.startedAt : 0,
                actual: run?.metrics || {
                  fps: 0,
                  bitrateKbps: 0,
                  speed: 0,
                },
                process: run?.pid
                  ? diagnosticSnapshot.processes[run.pid] || null
                  : null,
                restarts: run?.restarts || 0,
                viewers: mediaReady ? countViewers(readersByPath, row.id, c.slug) : null,
                lastErrorAt: run?.lastErrorAt || null,
                hls: `/live/${c.slug}/index.m3u8`,
                watch: `/channel/${c.slug}`,
                rtspPath: c.slug,
                rtspPort,
              };
            }),
          layouts: access === "viewer" ? [] : get("layouts") || [],
          diagnostics:
            access === "admin"
              ? {
                  ...diagnosticSnapshot.system,
                  previewCount: [...engine.channels.keys()].filter(
                    (id) =>
                      id.startsWith("preview-") || id.startsWith("studio-"),
                  ).length,
                  sourceDecoderCount: engine.sources.size,
                  channelEncoderCount: [...engine.channels.keys()].filter(
                    (id) =>
                      !id.startsWith("preview-") && !id.startsWith("studio-"),
                  ).length,
                }
              : null,
          logs: access === "admin" ? messages : [],
          viewer: null,
        });
      }
      if (
        pathname === "/api/diagnostics/encoders/test" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const b = await body(q),
          encoder = String(b.encoder || "");
        if (!encoders.includes(encoder))
          throw Error("Этот кодировщик не найден в FFmpeg");
        const started = Date.now(),
          extra =
            encoder === "libx264"
              ? ["-preset", "ultrafast"]
              : encoder === "h264_nvenc"
                ? ["-preset", "p4"]
                : ["-preset", "veryfast"];
        const result = await run(
          ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "warning",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=25",
            "-frames:v",
            "50",
            "-vf",
            "format=nv12",
            "-c:v",
            encoder,
            ...extra,
            "-f",
            "null",
            "-",
          ],
          20000,
        );
        const technical = String(result.err || "").slice(-1400);
        return json(r, 200, {
          ok: result.ok,
          encoder,
          durationMs: Date.now() - started,
          reason: result.ok
            ? "Кодировщик успешно обработал тестовое видео."
            : explainError(technical),
          technical,
        });
      }
      if (
        pathname === "/api/archive" &&
        q.method === "GET" &&
        access === "admin"
      )
        return json(r, 200, recordings.status());
      if (
        pathname === "/api/archive/settings" &&
        q.method === "PUT" &&
        access === "admin"
      ) {
        const clean = recordings.update(await body(q));
        audit(q, actor, "archive.settings", "recording", {
          jobs: clean.jobs.length,
        });
        return json(r, 200, clean);
      }
      if (
        pathname === "/api/archive/export" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const result = await recordings.exportClip(await body(q));
        audit(q, actor, "archive.export", result.id);
        return json(r, 201, { ...result, url: `/archive/export/${result.id}` });
      }
      if (
        pathname === "/api/archive/playback" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const result = await recordings.preparePlayback((await body(q)).fileId);
        return json(r, 200, result);
      }
      const archiveFile = pathname.match(/^\/api\/archive\/files\/(.+)$/);
      if (archiveFile && q.method === "DELETE" && access === "admin") {
        const id = decodeURIComponent(archiveFile[1]),
          item = recordings.files().find((x) => x.id === id);
        if (!item) throw Error("Запись не найдена");
        if (item.active) throw Error("Нельзя удалить текущий сегмент");
        fs.rmSync(recordings.resolve(id));
        audit(q, actor, "archive.delete", id);
        return json(r, 200, { ok: true });
      }
      const archiveStream = pathname.match(/^\/archive\/file\/(.+)$/);
      if (archiveStream && ["GET", "HEAD"].includes(q.method)) {
        if (access !== "admin")
          return json(r, 403, { error: "Нет доступа к архиву" });
        return serveVideo(
          q,
          r,
          recordings.resolve(decodeURIComponent(archiveStream[1])),
        );
      }
      const archivePlayback = pathname.match(/^\/archive\/play\/([a-f0-9]{64}\.mp4)$/);
      if (archivePlayback && ["GET", "HEAD"].includes(q.method)) {
        if (access !== "admin")
          return json(r, 403, { error: "Нет доступа к архиву" });
        return serveVideo(q, r, recordings.resolvePlayback(archivePlayback[1]));
      }
      const archiveExport = pathname.match(
        /^\/archive\/export\/([a-f0-9-]{36}\.mp4)$/,
      );
      if (archiveExport && ["GET", "HEAD"].includes(q.method)) {
        if (access !== "admin")
          return json(r, 403, { error: "Нет доступа к архиву" });
        return serveVideo(
          q,
          r,
          recordings.resolveExport(archiveExport[1]),
          true,
        );
      }
      if (
        pathname === "/api/users" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const b = await body(q),
          username = String(b.username || "")
            .trim()
            .toLowerCase(),
          password = String(b.password || ""),
          roleName = String(b.role || "");
        if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username))
          throw Error("Логин: 3–32 латинских символа");
        if (username === "any") throw Error("Этот логин зарезервирован");
        if (password.length < 10)
          throw Error("Пароль должен содержать минимум 10 символов");
        if (!["admin", "operator", "viewer"].includes(roleName))
          throw Error("Неверная роль");
        const id = crypto.randomUUID();
        db.prepare("INSERT INTO users VALUES(?,?,?,?,1,1,?,?)").run(
          id,
          username,
          hashPassword(password),
          roleName,
          encrypt(password),
          new Date().toISOString(),
        );
        for (const cid of Array.isArray(b.channels) ? b.channels : [])
          if (db.prepare("SELECT 1 FROM channels WHERE id=?").get(cid))
            db.prepare("INSERT OR IGNORE INTO user_channels VALUES(?,?)").run(
              id,
              cid,
            );
        syncAliases();
        mtx?.kill();
        audit(q, actor, "user.create", username, { role: roleName });
        return json(r, 201, { id });
      }
      const userRoute = pathname.match(/^\/api\/users\/([a-f0-9-]{36})$/);
      if (userRoute && access === "admin") {
        const row = db
          .prepare("SELECT * FROM users WHERE id=?")
          .get(userRoute[1]);
        if (!row) return json(r, 404, { error: "Пользователь не найден" });
        if (q.method === "PUT") {
          const b = await body(q),
            roleName = ["admin", "operator", "viewer"].includes(b.role)
              ? b.role
              : row.role,
            enabled = b.enabled !== false;
          if (row.id === actor.id && (!enabled || roleName !== "admin"))
            throw Error("Нельзя лишить себя доступа администратора");
          db.prepare(
            "UPDATE users SET role=?,enabled=?,session_version=session_version+1 WHERE id=?",
          ).run(roleName, enabled ? 1 : 0, row.id);
          if (b.password) {
            if (String(b.password).length < 10)
              throw Error("Пароль должен содержать минимум 10 символов");
            db.prepare(
              "UPDATE users SET password_hash=?,vlc_secret=? WHERE id=?",
            ).run(hashPassword(b.password), encrypt(b.password), row.id);
          }
          db.prepare("DELETE FROM user_channels WHERE user_id=?").run(row.id);
          for (const cid of Array.isArray(b.channels) ? b.channels : [])
            if (db.prepare("SELECT 1 FROM channels WHERE id=?").get(cid))
              db.prepare("INSERT OR IGNORE INTO user_channels VALUES(?,?)").run(
                row.id,
                cid,
              );
          if (row.username === "viewer") set("legacyViewerAutoAssign", false);
          const currentToken = (q.headers.cookie || "").match(
              /(?:^|; )wall=([a-f0-9]+)/,
            )?.[1],
            nextVersion = db
              .prepare("SELECT session_version FROM users WHERE id=?")
              .get(row.id).session_version;
          for (const [token, s] of sessions)
            if (s.userId === row.id) {
              if (row.id === actor.id && token === currentToken)
                s.version = nextVersion;
              else sessions.delete(token);
            }
          syncAliases();
          mtx?.kill();
          audit(q, actor, "user.update", row.username, {
            role: roleName,
            enabled,
          });
          return json(r, 200, { ok: true });
        }
        if (q.method === "DELETE") {
          if (row.id === actor.id)
            throw Error("Нельзя удалить собственную учётную запись");
          db.prepare(
            "UPDATE users SET enabled=0,session_version=session_version+1 WHERE id=?",
          ).run(row.id);
          for (const [token, s] of sessions)
            if (s.userId === row.id) sessions.delete(token);
          syncAliases();
          mtx?.kill();
          audit(q, actor, "user.revoke", row.username);
          return json(r, 200, { ok: true });
        }
      }
      const sessionRoute = pathname.match(/^\/api\/sessions\/([a-f0-9]{12})$/);
      if (sessionRoute && q.method === "DELETE" && access === "admin") {
        const token = [...sessions.keys()].find((x) =>
          x.startsWith(sessionRoute[1]),
        );
        if (token) sessions.delete(token);
        audit(q, actor, "session.revoke", sessionRoute[1]);
        return json(r, 200, { ok: true });
      }
      if (pathname === "/api/backups" && access === "admin") {
        if (q.method === "GET") return json(r, 200, backupsManager.list());
        if (q.method === "POST") return json(r, 201, backupsManager.create());
      }
      if (
        pathname === "/api/backups/import" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const b = await body(q, 140 * 1024 * 1024);
        return json(
          r,
          201,
          backupsManager.import(Buffer.from(b.data || "", "base64")),
        );
      }
      const backupAction = pathname.match(
        /^\/api\/backups\/([a-zA-Z0-9_.-]+)\/(restore|delete)$/,
      );
      if (backupAction && q.method === "POST" && access === "admin")
        return json(
          r,
          200,
          backupAction[2] === "restore"
            ? backupsManager.scheduleRestore(backupAction[1])
            : backupsManager.remove(backupAction[1]),
        );
      const backupFile = pathname.match(/^\/backup\/([a-zA-Z0-9_.-]+\.vwbak)$/);
      if (backupFile && q.method === "GET") {
        if (access !== "admin")
          return json(r, 401, { error: "Войдите как администратор" });
        const file = backupsManager.resolve(backupFile[1]);
        r.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${backupFile[1]}"`,
        });
        return fs.createReadStream(file).pipe(r);
      }
      if (
        pathname === "/api/events/acknowledge" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        db.prepare("UPDATE events SET acknowledged=1").run();
        return json(r, 200, { ok: true });
      }
      if (
        pathname === "/api/logos" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const b = await body(q, 1500000);
        if (
          typeof b.name !== "string" ||
          typeof b.data !== "string" ||
          !b.data.startsWith("data:image/png;base64,")
        )
          throw Error("Выберите PNG");
        const raw = Buffer.from(
          b.data.slice(b.data.indexOf(",") + 1),
          "base64",
        );
        if (!raw.length || raw.length > 1048576)
          throw Error("PNG должен быть не больше 1 МБ");
        const id = crypto.randomUUID(),
          out = path.join(renderDir, id + ".png"),
          p = spawnSync(
            ffmpeg,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-i",
              "pipe:0",
              "-vf",
              "scale=512:512:force_original_aspect_ratio=decrease",
              "-frames:v",
              "1",
              "-y",
              out,
            ],
            { input: raw, timeout: 15000, windowsHide: true },
          );
        if (p.status !== 0 || !fs.existsSync(out))
          throw Error("Не удалось прочитать PNG");
        const logos = [
          ...(get("logos") || []),
          { id, name: b.name.trim().slice(0, 80) || "Логотип" },
        ];
        set("logos", logos);
        return json(r, 201, { id });
      }
      const logo = pathname.match(/^\/api\/logos\/([a-f0-9-]{36})\.png$/);
      if (logo && q.method === "GET") {
        const file = path.join(renderDir, logo[1] + ".png");
        if (!fs.existsSync(file))
          return json(r, 404, { error: "Логотип не найден" });
        r.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=3600",
        });
        return fs.createReadStream(file).pipe(r);
      }
      if (
        pathname === "/api/network/check" &&
        q.method === "GET" &&
        access === "admin"
      ) {
        const targets = networkAddresses();
        return json(r, 200, {
          bindAddress: host,
          results: await Promise.all(
            targets.flatMap(({ name, address }) => [
              checkTcp(address, server.address().port).then((x) => ({ ...x, name, address, protocol: "HTTP", port: server.address().port })),
              checkTcp(address, rtspPort).then((x) => ({ ...x, name, address, protocol: "RTSP", port: rtspPort })),
            ]),
          ),
        });
      }
      if (
        pathname === "/api/network" &&
        q.method === "PUT" &&
        access === "admin"
      ) {
        const b = await body(q);
        if (typeof b.lan !== "boolean") throw Error("Неверная настройка");
        const publicHost = String(b.publicHost || "").trim();
        if (publicHost && (!/^[a-zA-Z0-9.-]{1,253}$/.test(publicHost) || publicHost.startsWith(".") || publicHost.endsWith(".")))
          throw Error("Укажите IP-адрес или домен без протокола и порта");
        const restartRequired = b.lan !== (host === "0.0.0.0");
        set("network", { lan: b.lan, publicHost });
        const firewallRequested =
          b.lan && requestWindowsFirewall(server.address().port, rtspPort, log);
        json(r, 200, {
          restartRequired,
          restarting: restartRequired && !!options.serviceMode,
          firewallRequested,
        });
        if (restartRequired && options.serviceMode)
          setTimeout(() => process.exit(75), 1200).unref();
        return;
      }
      if (
        pathname === "/api/layouts" &&
        q.method === "PUT" &&
        ["admin", "operator"].includes(access)
      ) {
        const b = await body(q);
        if (
          !Array.isArray(b) ||
          b.length > 200 ||
          b.some(
            (l) =>
              typeof l.name !== "string" ||
              l.name.length > 80 ||
              ![1, 4, 6, 8, 9, 16, 20, 25, 36, 49, 64].includes(l.size) ||
              !Array.isArray(l.slots) ||
              l.slots.length !== l.size ||
              l.slots.some((id) => id && !source(id)),
          )
        )
          throw Error("Неверная раскладка");
        const layouts = b.map((l) => ({
          ...l,
          name: l.name.trim(),
          id: l.id || crypto.randomUUID(),
          fits: validFits(l.fits, l.size),
        }));
        if (
          layouts.some((l) => !l.name) ||
          new Set(layouts.map((l) => l.id)).size !== layouts.length
        )
          throw Error("Проверьте названия раскладок");
        set("layouts", layouts);
        audit(q, actor, "layout.update", "layouts", { count: layouts.length });
        return json(r, 200, { ok: true });
      }
      if (
        pathname === "/api/capture/inventory" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const b=await body(q);
        captureInventory={
          displays:Array.isArray(b.displays)?b.displays.slice(0,32).map(x=>({id:String(x.id||''),name:String(x.name||'Монитор'),x:Number(x.x||0),y:Number(x.y||0),width:Number(x.width||0),height:Number(x.height||0),primary:!!x.primary})).filter(x=>x.id&&x.width>0&&x.height>0):[],
          windows:Array.isArray(b.windows)?b.windows.slice(0,256).map(x=>({id:String(x.id||x.name||''),name:String(x.name||x.id||'Окно')})).filter(x=>x.id):[],
          devices:Array.isArray(b.devices)?b.devices.slice(0,128).map(x=>({id:String(x.id||x.name||''),name:String(x.name||x.id||'Видеоустройство')})).filter(x=>x.id):[],
          updatedAt:Date.now(),
        };
        return json(r,200,{ok:true});
      }
      if (pathname === "/api/capture/inventory" && q.method === "GET" && access === "admin")
        return json(r,200,captureInventory);
      if (pathname === "/api/capture/status" && q.method === "POST" && access === "admin") {
        const b=await body(q),id=String(b.id||"");
        if(!idPattern.test(id)||!source(id))throw Error("Источник не найден");
        captureStatuses.set(id,{status:["connecting","online","offline"].includes(b.status)?b.status:"offline",error:String(b.error||"").slice(-700),updatedAt:Date.now()});
        return json(r,200,{ok:true});
      }
      if (
        pathname === "/api/onvif/discover" &&
        q.method === "GET" &&
        access === "admin"
      ) {
        return json(r, 200, { devices: await onvif.discover() });
      }
      if (
        pathname === "/api/onvif/add" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const b = await body(q),
          config = {
            host: String(b.host || "").trim(),
            port: Number(b.port || 80),
            path: String(b.path || "/onvif/device_service"),
            username: String(b.username || ""),
            password: String(b.password || ""),
          };
        if (!config.host) throw Error("Не указан адрес камеры");
        const details = await onvif.inspect(config),
          stream = new URL(details.streamUri);
        if (config.username) stream.username = config.username;
        if (config.password) stream.password = config.password;
        const id = crypto.randomUUID(),
          name = String(b.name || `${details.manufacturer} ${details.model}` || config.host).trim().slice(0, 80),
          quality = ["360p", "720p", "1080p"].includes(b.quality) ? b.quality : "720p";
        db.prepare("INSERT INTO sources(id,name,url,quality,description,transport,enabled) VALUES(?,?,?,?,?,?,1)").run(id, name || config.host, encrypt(stream.href), quality, "", "tcp");
        saveOnvifConfig(id, config);
        audit(q, actor, "onvif.add", id, { host: config.host, model: details.model });
        return json(r, 201, { id, details });
      }
      const onvifRoute = pathname.match(/^\/api\/sources\/([a-zA-Z0-9_-]+)\/onvif(?:\/(command))?$/);
      if (onvifRoute && ["admin", "operator"].includes(access)) {
        const id = onvifRoute[1], old = source(id);
        if (!old) return json(r, 404, { error: "Источник не найден" });
        if (q.method === "PUT" && !onvifRoute[2]) {
          if (access !== "admin") return json(r, 403, { error: "Нет доступа" });
          const b = await body(q), previous = onvifConfig(id), stream = new URL(old.url),
            config = {
              host: String(b.host || previous?.host || stream.hostname).trim(),
              port: Number(b.port || previous?.port || 80),
              path: String(b.path || previous?.path || "/onvif/device_service"),
              username: String(b.username ?? previous?.username ?? decodeURIComponent(stream.username || "")),
              password: String(b.password || previous?.password || decodeURIComponent(stream.password || "")),
            };
          const details = await onvif.inspect(config);
          saveOnvifConfig(id, config);
          audit(q, actor, "onvif.configure", id, { host: config.host });
          return json(r, 200, details);
        }
        const config = onvifConfig(id);
        if (!config) throw Error("Сначала настройте ONVIF для источника");
        if (q.method === "GET" && !onvifRoute[2])
          return json(r, 200, await onvif.inspect(config));
        if (q.method === "POST" && onvifRoute[2]) {
          const input = await body(q), result = await onvif.command(config, input);
          audit(q, actor, "onvif." + input.action, id);
          return json(r, 200, result);
        }
      }
      if (
        pathname === "/api/sources" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const b = await body(q);
        if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80)
          throw Error("Укажите название");
        const url = captureUrl(b) || new URL(b.url);
        if (!["rtsp:", "http:", "https:", "screen:", "window:", "dshow:"].includes(url.protocol))
          throw Error("Поддерживаются HTTP, HTTPS, RTSP, экран и видеоустройства");
        if (!captureInfo(url.href) && b.username) url.username = b.username;
        if (!captureInfo(url.href) && b.password) url.password = b.password;
        const quality = b.quality || "720p", description=String(b.description||"").trim(), transport=b.transport==="udp"?"udp":"tcp";
        if (!["360p", "720p", "1080p"].includes(quality))
          throw Error("Неверное качество");
        if(description.length>500) throw Error("Описание — не больше 500 символов");
        const id = crypto.randomUUID();
        db.prepare("INSERT INTO sources(id,name,url,quality,description,transport,enabled) VALUES(?,?,?,?,?,?,1)").run(id,b.name.trim(),encrypt(url.href),quality,description,transport);
        set("sourceOrder",[...(get("sourceOrder")||[]).filter((x)=>x!==id),id]);
        return json(r, 201, { id });
      }
      if (pathname === "/api/sources/order" && q.method === "PUT" && ["admin","operator"].includes(access)) {
        const b=await body(q),ids=Array.isArray(b.ids)?b.ids:[],actual=db.prepare("SELECT id FROM sources").all().map((x)=>x.id);
        if(ids.length!==actual.length||new Set(ids).size!==ids.length||ids.some((id)=>!actual.includes(id))) throw Error("Неверный порядок источников");
        set("sourceOrder",ids); return json(r,200,{ok:true});
      }
      const sourceToggle=pathname.match(/^\/api\/sources\/([a-zA-Z0-9_-]+)\/(enable|disable)$/);
      if(sourceToggle&&q.method==="POST"&&["admin","operator"].includes(access)){
        const id=sourceToggle[1],enabled=sourceToggle[2]==="enable";
        if(!source(id)) return json(r,404,{error:"Источник не найден"});
        db.prepare("UPDATE sources SET enabled=? WHERE id=?").run(enabled?1:0,id);
        await engine.restartSource(id);
        audit(q,actor,enabled?"source.enable":"source.disable",id);
        return json(r,200,{ok:true,enabled});
      }
      const src = pathname.match(
        /^\/api\/sources\/([a-zA-Z0-9_-]+)(?:\/(preview))?$/,
      );
      if (src) {
        const id = src[1];
        if (!source(id)) return json(r, 404, { error: "Источник не найден" });
        if (q.method === "POST" && src[2] === "preview") {
          if (!["admin", "operator"].includes(access))
            return json(r, 403, { error: "Нет доступа" });
          const b = await body(q),
            fit = b.fit === "contain" ? "contain" : "cover";
          const c = {
            id: "preview-" + id + (fit === "cover" ? "-cover" : ""),
            fits: [fit],
            name: "Preview",
            slots: [id],
            size: 1,
            quality: "360p",
            fps: 10,
            bitrate: 500,
          };
          await startChannel(c);
          previewLeases.set(c.id, Date.now() + 15000);
          return json(r, 200, { hls: `/live/${streamName(c.id)}/index.m3u8` });
        }
        if (q.method === "PUT" && access === "admin") {
          const b = await body(q),
            old = source(id);
          if (
            typeof b.name !== "string" ||
            !b.name.trim() ||
            b.name.length > 80 ||
            !["360p", "720p", "1080p"].includes(b.quality)
          )
            throw Error("Проверьте название и качество");
          let url = captureUrl(b) || new URL(b.url || old.url);
          const previousURL = new URL(old.url);
          if (!captureInfo(url.href) && !url.username && !b.username) url.username = previousURL.username;
          if (!captureInfo(url.href) && !url.password && !b.password) url.password = previousURL.password;
          if (!["rtsp:", "http:", "https:", "screen:", "window:", "dshow:"].includes(url.protocol))
            throw Error("Неверный URL");
          if (!captureInfo(url.href) && b.username) url.username = b.username;
          if (!captureInfo(url.href) && b.password) url.password = b.password;
          const affected = [...engine.channels.values()]
            .filter((c) => c.ids.includes(id))
            .map((c) => ({ config: c.config, publish: c.publish }));
          for (const c of affected) await engine.stop(c.config.id);
          const description=String(b.description||"").trim(),transport=b.transport==="udp"?"udp":"tcp";
          if(description.length>500) throw Error("Описание — не больше 500 символов");
          db.prepare(
            "UPDATE sources SET name=?,url=?,quality=?,description=?,transport=? WHERE id=?",
          ).run(b.name.trim(), encrypt(url.href), b.quality,description,transport,id);
          const cameraConfig = onvifConfig(id);
          if (cameraConfig && (b.username || b.password))
            saveOnvifConfig(id, {
              ...cameraConfig,
              username: b.username || cameraConfig.username,
              password: b.password || cameraConfig.password,
            });
          for (const c of affected) await engine.start(c.config, c.publish);
          return json(r, 200, { ok: true });
        }
        if (q.method === "DELETE" && access === "admin") {
          if (
            recordings
              .settings()
              .jobs.some((j) => j.type === "source" && j.targetId === id)
          )
            throw Error("Источник используется в задании записи");
          if (
            db
              .prepare("SELECT config FROM channels")
              .all()
              .some(
                (r) =>
                  JSON.parse(r.config).slots.includes(id) ||
                  JSON.parse(r.config).audioSource === id,
              )
          )
            throw Error("Источник используется в канале");
          for (const suffix of ["", "-cover"]) {
            await engine.stop("preview-" + id + suffix);
            previewLeases.delete("preview-" + id + suffix);
          }
          db.prepare("DELETE FROM sources WHERE id=?").run(id);
          set("sourceOrder",(get("sourceOrder")||[]).filter((x)=>x!==id));
          captureStatuses.delete(id);
          const onvifSources = get("onvifSources") || {};
          delete onvifSources[id];
          set("onvifSources", onvifSources);
          set(
            "layouts",
            (get("layouts") || []).map((l) => ({
              ...l,
              slots: l.slots.map((s) => (s === id ? null : s)),
            })),
          );
          return json(r, 200, { ok: true });
        }
      }
      if (
        pathname === "/api/channels" &&
        q.method === "POST" &&
        access === "admin"
      ) {
        const input = await body(q),
          c = {
            ...validateChannel(input),
            slug: validateSlug(input.slug),
            id: crypto.randomUUID(),
          };
        db.exec("BEGIN");
        try {
          db.prepare("INSERT INTO channels VALUES(?,?,0)").run(
            c.id,
            JSON.stringify(c),
          );
          db.prepare("INSERT INTO channel_names VALUES(?,?)").run(c.slug, c.id);
          if (get("legacyViewerAutoAssign")) {
            const viewer = db
              .prepare("SELECT id FROM users WHERE username='viewer'")
              .get();
            if (viewer)
              db.prepare("INSERT OR IGNORE INTO user_channels VALUES(?,?)").run(
                viewer.id,
                c.id,
              );
          }
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        syncAliases();
        set("channelOrder",[...(get("channelOrder")||[]).filter((x)=>x!==c.id),c.id]);
        audit(q, actor, "channel.create", c.id, { name: c.name });
        return json(r, 201, c);
      }
      if(pathname==="/api/channels/order"&&q.method==="PUT"&&["admin","operator"].includes(access)){
        const b=await body(q),ids=Array.isArray(b.ids)?b.ids:[],actual=db.prepare("SELECT id FROM channels").all().map((x)=>x.id);
        if(ids.length!==actual.length||new Set(ids).size!==ids.length||ids.some((id)=>!actual.includes(id))) throw Error("Неверный порядок каналов");
        set("channelOrder",ids); return json(r,200,{ok:true});
      }
      const studio = pathname.match(
        /^\/api\/channels\/([a-zA-Z0-9_-]+)\/(draft|preview-draft|take)$/,
      );
      if (studio && access === "admin") {
        const id = studio[1],
          action = studio[2],
          row = db.prepare("SELECT * FROM channels WHERE id=?").get(id);
        if (!row) return json(r, 404, { error: "Канал не найден" });
        if (!canAccess(actor, id))
          return json(r, 403, { error: "Нет доступа к каналу" });
        const current = JSON.parse(row.config);
        let d = db.prepare("SELECT * FROM drafts WHERE channel_id=?").get(id);
        if (!d) {
          db.prepare("INSERT INTO drafts VALUES(?,?,1,?)").run(
            id,
            row.config,
            row.config,
          );
          d = db.prepare("SELECT * FROM drafts WHERE channel_id=?").get(id);
        }
        if (action === "draft" && q.method === "GET")
          return json(r, 200, {
            config: JSON.parse(d.config),
            revision: d.revision,
            conflict: d.base_config !== row.config,
          });
        if (action === "draft" && q.method === "PUT") {
          const b = await body(q);
          if (b.revision !== d.revision)
            return json(r, 409, {
              error: "Черновик уже изменён в другом окне",
            });
          const config = {
            ...validateChannel({ ...b.config, name: current.name }),
            id,
            slug: current.slug,
          };
          db.prepare(
            "UPDATE drafts SET config=?,revision=revision+1 WHERE channel_id=?",
          ).run(JSON.stringify(config), id);
          await engine.stop("studio-" + id);
          return json(r, 200, { revision: d.revision + 1 });
        }
        if (action === "draft" && q.method === "DELETE") {
          db.prepare(
            "UPDATE drafts SET config=?,revision=revision+1,base_config=? WHERE channel_id=?",
          ).run(row.config, row.config, id);
          await engine.stop("studio-" + id);
          return json(r, 200, { revision: d.revision + 1 });
        }
        if (action === "preview-draft" && q.method === "POST") {
          const config = { ...JSON.parse(d.config), id: "studio-" + id,
            quality: "360p", fps: 10, bitrate: 600, encoder: "libx264" };
          await engine.stop(config.id);
          await startChannel(config);
          previewLeases.set(config.id, Date.now() + 45000);
          return json(r, 200, {
            hls: `/live/${streamName(config.id)}/index.m3u8`,
          });
        }
        if (action === "take" && q.method === "POST") {
          const b = await body(q);
          if (b.revision !== d.revision)
            return json(r, 409, { error: "Черновик уже изменён" });
          if (d.base_config !== row.config)
            return json(r, 409, {
              error: "Эфирный канал изменился. Обновите черновик",
            });
          const next = { ...JSON.parse(d.config), id, slug: current.slug },
            probe = { ...next, id: "studio-" + id };
          await engine.stop(probe.id);
          try {
            await startChannel(probe);
            await waitReady(probe.id);
            await engine.stop(id);
            await startChannel(next);
            await waitReady(id);
            db.prepare("UPDATE channels SET config=?,desired=1 WHERE id=?").run(
              JSON.stringify(next),
              id,
            );
            db.prepare(
              "UPDATE drafts SET config=?,revision=revision+1,base_config=? WHERE channel_id=?",
            ).run(JSON.stringify(next), JSON.stringify(next), id);
            audit(q, actor, "channel.take", id, { revision: d.revision + 1 });
            return json(r, 200, { ok: true, revision: d.revision + 1 });
          } catch (e) {
            await engine.stop(id);
            if (row.desired) {
              await startChannel(current);
              await waitReady(id).catch(() => {});
            }
            throw e;
          } finally {
            await engine.stop(probe.id);
          }
        }
      }
      const match = pathname.match(
        /^\/api\/channels\/([a-zA-Z0-9_-]+)(?:\/(start|stop))?$/,
      );
      const automationMatch = pathname.match(
        /^\/api\/channels\/([a-zA-Z0-9_-]+)\/automation$/,
      );
      if (automationMatch && q.method === "PUT" && access === "admin") {
        const row = db
          .prepare("SELECT * FROM channels WHERE id=?")
          .get(automationMatch[1]);
        if (!row) return json(r, 404, { error: "Канал не найден" });
        const c = JSON.parse(row.config),
          b = await body(q);
        c.automation = validateAutomation(b.automation);
        c.backups = Array.isArray(b.backups)
          ? b.backups.slice(0, c.size)
          : c.backups || Array(c.size).fill(null);
        while (c.backups.length < c.size) c.backups.push(null);
        for (let i = 0; i < c.size; i++)
          if (
            c.backups[i] &&
            (!source(c.backups[i]) || c.backups[i] === c.slots[i])
          )
            throw Error("Неверный резервный источник");
        c.fallbackDelay = Math.max(
          4,
          Math.min(60, Number(b.fallbackDelay) || 5),
        );
        delete scheduleOverrides[row.id];
        set("scheduleOverrides", scheduleOverrides);
        db.prepare("UPDATE channels SET config=? WHERE id=?").run(
          JSON.stringify(c),
          row.id,
        );
        if (engine.channels.has(c.id)) {
          await engine.stop(c.id);
          await startChannel(c);
        }
        audit(q, actor, "channel.automation", row.id);
        return json(r, 200, { ok: true });
      }
      if (match && ["admin", "operator"].includes(access)) {
        const id = match[1],
          row = db.prepare("SELECT * FROM channels WHERE id=?").get(id);
        if (!row) return json(r, 404, { error: "Канал не найден" });
        if (!canAccess(actor, id))
          return json(r, 403, { error: "Нет доступа к каналу" });
        if (q.method === "POST" && match[2]) {
          const config = JSON.parse(row.config);
          if (config.automation?.schedule?.enabled) {
            scheduleOverrides[id] = {
              value: match[2] === "start",
              until: nextBoundary(config.automation),
            };
            set("scheduleOverrides", scheduleOverrides);
          }
          if (match[2] === "start") {
            await startChannel(JSON.parse(row.config));
            db.prepare("UPDATE channels SET desired=1 WHERE id=?").run(id);
          } else {
            db.prepare("UPDATE channels SET desired=0 WHERE id=?").run(id);
            await engine.stop(id);
          }
          audit(q, actor, `channel.${match[2]}`, id);
          return json(r, 200, { ok: true });
        }
        if (q.method === "PUT") {
          const c = {
            ...validateChannel(await body(q)),
            slug: JSON.parse(row.config).slug,
            id,
          };
          await engine.stop(id);
          db.prepare("UPDATE channels SET config=? WHERE id=?").run(
            JSON.stringify(c),
            id,
          );
          if (row.desired) await startChannel(c);
          audit(q, actor, "channel.update", id);
          return json(r, 200, c);
        }
        if (q.method === "DELETE") {
          if (access !== "admin")
            return json(r, 403, {
              error: "Удалять каналы может только администратор",
            });
          if (
            recordings
              .settings()
              .jobs.some((j) => j.type === "channel" && j.targetId === id)
          )
            throw Error("Канал используется в задании записи");
          await engine.stop(id);
          db.prepare("DELETE FROM channels WHERE id=?").run(id);
          db.prepare("DELETE FROM channel_names WHERE channel_id=?").run(id);
          db.prepare("DELETE FROM user_channels WHERE channel_id=?").run(id);
          set("channelOrder",(get("channelOrder")||[]).filter((x)=>x!==id));
          syncAliases();
          audit(q, actor, "channel.delete", id);
          return json(r, 200, { ok: true });
        }
      }
      if (pathname.startsWith("/live/") && q.method === "GET") {
        if (!/^\/live\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]*$/.test(pathname))
          return json(r, 400, { error: "Неверный путь" });
        const parts = pathname.split("/");
        if (parts[2].startsWith("channel-studio-") && access !== "admin")
          return json(r, 403, {
            error: "Черновик доступен только администратору",
          });
        const studioPreview = parts[2].match(/^channel-(studio-[a-f0-9-]{36})$/);
        if (studioPreview && previewLeases.has(studioPreview[1]))
          previewLeases.set(studioPreview[1], Date.now() + 45000);
        const alias = db
          .prepare("SELECT channel_id FROM channel_names WHERE slug=?")
          .get(parts[2]);
        if (alias && !canAccess(actor, alias.channel_id))
          return json(r, 403, { error: "Нет доступа к каналу" });
        if (!alias) {
          const internal = parts[2].match(/^channel-([a-f0-9-]{36})$/);
          if (
            access === "viewer" &&
            (!internal || !canAccess(actor, internal[1]))
          )
            return json(r, 403, { error: "Нет доступа к служебному потоку" });
        }
        if (alias) parts[2] = streamName(alias.channel_id);
        const upstream = parts.slice(2).join("/");
        const proxy = http.get(
          { host: "127.0.0.1", port: hlsPort, path: "/" + upstream + u.search },
          (up) => {
            const headers = {
              "Content-Type":
                up.headers["content-type"] || "application/octet-stream",
              "Cache-Control": "no-store",
            };
            if (up.headers.location) {
              const redirect = new URL(
                up.headers.location,
                "http://127.0.0.1:" + hlsPort + pathname.slice(5),
              );
              headers.Location =
                redirect.pathname.replace(
                  "/" + parts[2] + "/",
                  "/live/" + pathname.split("/")[2] + "/",
                ) + redirect.search;
            }
            r.writeHead(up.statusCode, headers);
            up.pipe(r);
          },
        );
        proxy.setTimeout(15000, () => proxy.destroy());
        proxy.on("error", () => {
          if (!r.headersSent) json(r, 502, { error: "Поток ещё не готов" });
          else r.destroy();
        });
        r.on("close", () => proxy.destroy());
        return;
      }
      const staticFiles = {
        "/": "index.html",
        "/app.js": "app.js",
        "/app.css": "app.css",
        "/streamhub-logo.svg": "streamhub-logo.svg",
        "/layouts.js": "layouts.js",
        "/monitoring.js": "monitoring.js",
        "/hls.min.js": "vendor/hls.min.js",
        "/watch": "watch.html",
        "/watch.js": "watch.js",
        "/watch.css": "watch.css",
        "/mobile": "mobile.html",
        "/mobile.js": "mobile.js",
        "/mobile.css": "mobile.css",
        "/studio.js": "studio.js",
        "/studio.css": "studio.css",
      };
      if (/^\/watch\/[a-z0-9-]{1,48}$/.test(pathname))
        staticFiles[pathname] = "watch.html";
      if (/^\/channel\/[a-z0-9-]{1,48}$/.test(pathname))
        staticFiles[pathname] = "watch.html";
      if (/^\/studio\/[a-zA-Z0-9_-]+$/.test(pathname))
        staticFiles[pathname] = "studio.html";
      if (/^\/studio\/[a-zA-Z0-9_-]+$/.test(pathname) && access !== "admin")
        return json(r, access ? 403 : 404, { error: "Студия доступна администратору" });
      if (staticFiles[pathname] && q.method === "GET") {
        r.writeHead(200, {
          "Content-Type": pathname.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : pathname.endsWith(".css")
              ? "text/css; charset=utf-8"
              : pathname.endsWith(".svg")
                ? "image/svg+xml"
              : "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        fs.createReadStream(path.join(__dirname, staticFiles[pathname])).pipe(
          r,
        );
        return;
      }
      return json(r, access ? 403 : 404, { error: "Недоступная операция" });
    } catch (e) {
      if (!r.headersSent)
        json(r, 400, {
          error: String(e.message).replace(/(?:rtsp|https?):\/\/\S+/g, "[url]"),
        });
      else r.destroy();
    } finally {
      unlock?.();
    }
  });
  await new Promise((ok, no) => {
    server.once("error", no);
    server.listen(port, host, ok);
  });
  const leaseTimer = setInterval(() => {
    for (const [id, until] of previewLeases)
      if (until < Date.now()) {
        previewLeases.delete(id);
        engine.stop(id);
      }
    for (const [t, s] of sessions) if (s.until < Date.now()) sessions.delete(t);
    for (const [ip, a] of attempts)
      if (a.until < Date.now()) attempts.delete(ip);
  }, 5000);
  refreshMonitoring().catch((error) => log("monitoring", error.message));
  const monitorTimer = setInterval(
    () => refreshMonitoring().catch((error) => log("monitoring", error.message)),
    15000,
  );
  // Renew long-lived RTSP connections only while their decoders are active.
  // Stagger renewals so many cameras do not reconnect simultaneously.
  let renewingSources = false;
  const sourceRenewTimer = setInterval(async () => {
    if (closing || renewingSources) return;
    renewingSources = true;
    try {
      const now = Date.now();
      const candidate = [...engine.sources.values()].find((item) =>
        item.process && item.state === "online" && now - item.startedAt > 60000 &&
        source(item.id)?.enabled !== 0);
      if (candidate) await engine.restartSource(candidate.id);
    } catch (error) { log("source-renew", error.message); }
    finally { renewingSources = false; }
  }, 5000);
  const applySchedules = async () => {
    let dirty = false;
    for (const row of db.prepare("SELECT * FROM channels").all()) {
      const c = JSON.parse(row.config),
        override = scheduleOverrides[c.id];
      if (override && override.until <= Date.now()) {
        delete scheduleOverrides[c.id];
        dirty = true;
      }
      const active = scheduleOverrides[c.id],
        should = active
          ? active.value
          : c.automation?.schedule?.enabled
            ? scheduleShouldRun(c.automation)
            : !!row.desired;
      if (should && !engine.channels.has(c.id)) {
        await startChannel(c).catch((e) => log("schedule", e.message));
      } else if (!should && engine.channels.has(c.id)) {
        await engine.stop(c.id);
        log("schedule", `${c.name}: остановлен расписанием`);
      }
    }
    if (dirty) set("scheduleOverrides", scheduleOverrides);
  };
  await applySchedules();
  const scheduleTimer = setInterval(
    () => applySchedules().catch((e) => log("schedule", e.message)),
    30000,
  );
  backupsManager.start();
  recordings.startLoop();
  return {
    port: server.address().port,
    credentials,
    dir,
    engine,
    async close() {
      closing = true;
      diagnostics.close();
      clearInterval(poll);
      clearInterval(leaseTimer);
      clearInterval(monitorTimer);
      clearInterval(sourceRenewTimer);
      clearInterval(scheduleTimer);
      backupsManager.close();
      await recordings.close();
      clearTimeout(mtxTimer);
      await engine.close();
      await terminate(mtx);
      server.closeAllConnections();
      await new Promise((ok) => server.close(ok));
      db.close();
    },
  };
}
module.exports = { startServer };
if (require.main === module)
  startServer()
    .then((app) => {
      console.log(
        `STREAMHUB: http://127.0.0.1:${app.port}\nДанные и первый пароль: ${app.dir}`,
      );
      let exiting = false;
      for (const s of ["SIGINT", "SIGTERM"])
        process.on(s, async () => {
          if (exiting) return;
          exiting = true;
          await app.close();
          process.exit(0);
        });
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
