"use strict";

const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog, screen, desktopCapturer } = require("electron");
const { startServer } = require("./server.cjs");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");

let backend, win, tray, quitting = false, ownsServer = false, captureTimer, captureSyncBusy = false;
const captureProcesses = new Map();
let deviceCache={at:0,items:[]};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function healthy() {
  try {
    const response = await fetch("http://127.0.0.1:8080/api/health", {
      cache: "no-store", signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) throw Error("Порт 8080 занят другим сервером");
    const health = await response.json();
    if (health.ok !== true || health.version !== app.getVersion())
      throw Error(`Порт 8080 занят несовместимой версией сервера (${health.version || "неизвестно"}). Остановите старую службу VideowallServer и запустите STREAMHUB снова.`);
    return true;
  } catch (error) {
    if (error.cause?.code === "ECONNREFUSED" || error.cause?.code === "ECONNRESET" || error.name === "TimeoutError") return false;
    throw error;
  }
}

async function readDesktopToken(dataDir) {
  const tokenFile = path.join(dataDir, "desktop.token");
  for (let i = 0; i < 20; i++) {
    try {
      const token = fs.readFileSync(tokenFile, "utf8").trim();
      if (token) return token;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(250);
  }
  throw new Error("Сервер запущен с другой папкой данных. Установите актуальную версию STREAMHUB поверх текущей и перезапустите приложение. Настройки удалять не нужно.");
}

function ffmpegPath() {
  return [path.join(process.resourcesPath, "bin", "ffmpeg.exe"), path.join(__dirname, "bin", "ffmpeg.exe")].find(fs.existsSync) || "ffmpeg.exe";
}

function videoDevices() {
  if(Date.now()-deviceCache.at<30000)return deviceCache.items;
  const result=spawnSync(ffmpegPath(),["-hide_banner","-list_devices","true","-f","dshow","-i","dummy"],{encoding:"utf8",windowsHide:true,timeout:10000}), devices=[];
  for(const line of String(result.stderr||"").split(/\r?\n/)) {
    if(/Alternative name/i.test(line)) continue;
    const match=line.match(/"([^"]+)"\s*\(video\)/i);
    if(match&&!devices.some(x=>x.id===match[1])) devices.push({id:match[1],name:match[1]});
  }
  deviceCache={at:Date.now(),items:devices};return devices;
}

function captureArgs(source, rtspPort, displays) {
  const c=source.capture, fps=String(c.fps||25), output=`rtsp://127.0.0.1:${rtspPort}/capture-${source.id}`;
  let input;
  if(c.kind==="screen") {
    const display=displays.find(x=>x.id===c.target), x=Number.isFinite(c.x)?c.x:(display?.x||0), y=Number.isFinite(c.y)?c.y:(display?.y||0), width=c.width||display?.width||1280, height=c.height||display?.height||720;
    input=["-f","gdigrab","-draw_mouse",c.cursor===false?"0":"1","-framerate",fps,"-offset_x",String(x),"-offset_y",String(y),"-video_size",`${width}x${height}`,"-i","desktop"];
  } else if(c.kind==="window") {
    input=["-f","gdigrab","-draw_mouse",c.cursor===false?"0":"1","-framerate",fps,"-i",`title=${c.target}`];
  } else {
    input=["-f","dshow","-rtbufsize","512M","-framerate",fps,"-video_size",`${c.width||1280}x${c.height||720}`];
    if(c.format==="mjpeg") input.push("-vcodec","mjpeg");
    else if(c.format&&c.format!=="auto") input.push("-pixel_format",c.format);
    input.push("-i",`video=${c.target}`);
  }
  return ["-hide_banner","-loglevel","warning","-nostdin",...input,"-an","-c:v","libx264","-preset","ultrafast","-tune","zerolatency","-pix_fmt","yuv420p","-g",fps,"-f","rtsp","-rtsp_transport","tcp",output];
}

async function syncCaptureAgent(token) {
  if(!backend||quitting) return;
  const displays=screen.getAllDisplays().map((d,i)=>({id:String(d.id),name:`Монитор ${i+1} · ${d.size.width}×${d.size.height}`,x:d.bounds.x,y:d.bounds.y,width:d.bounds.width,height:d.bounds.height,primary:d.id===screen.getPrimaryDisplay().id}));
  const windows=(await desktopCapturer.getSources({types:["window"],thumbnailSize:{width:0,height:0},fetchWindowIcons:false})).filter(x=>x.name&&x.name!=="STREAMHUB").map(x=>({id:x.name,name:x.name}));
  const headers={"Content-Type":"application/json","X-Desktop-Token":token};
  await fetch(`http://127.0.0.1:${backend.port}/api/capture/inventory`,{method:"POST",headers,body:JSON.stringify({displays,windows,devices:videoDevices()})}).catch(()=>{});
  const response=await fetch(`http://127.0.0.1:${backend.port}/api/state`,{headers}).catch(()=>null);
  if(!response?.ok) return;
  const state=await response.json(), wanted=new Set();
  for(const source of state.sources.filter(x=>x.capture)) {
    wanted.add(source.id);
    const args=captureArgs(source,state.network.rtspPort,displays), signature=JSON.stringify(args), current=captureProcesses.get(source.id);
    if(current?.signature===signature&&current.process.exitCode===null) continue;
    current?.process.kill("SIGKILL");
    const report=(status,error="")=>fetch(`http://127.0.0.1:${backend.port}/api/capture/status`,{method:"POST",headers,body:JSON.stringify({id:source.id,status,error})}).catch(()=>{});
    const process=spawn(ffmpegPath(),args,{stdio:["ignore","ignore","pipe"],windowsHide:true});let error="";
    captureProcesses.set(source.id,{process,signature});
    report("connecting");process.stderr.on("data",b=>error=(error+String(b)).slice(-700));
    const ready=setTimeout(()=>{if(process.exitCode===null)report("online")},2500);
    process.once("close",()=>{clearTimeout(ready);report("offline",error||"Устройство захвата недоступно или занято другим приложением");if(captureProcesses.get(source.id)?.process===process)captureProcesses.delete(source.id)});
  }
  for(const [id,item] of captureProcesses) if(!wanted.has(id)){item.process.kill("SIGKILL");captureProcesses.delete(id)}
}

async function runCaptureSync(token) {
  if (captureSyncBusy || quitting) return;
  captureSyncBusy = true;
  try { await syncCaptureAgent(token); }
  catch (error) { console.error("Capture sync:", error); }
  finally { captureSyncBusy = false; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    const dir = path.join(app.getPath("userData"), "data");
    if (await healthy()) backend = { port: 8080, dir, close: async () => {} };
    else {
      backend = await startServer({ dataDir: dir });
      ownsServer = true;
    }
    const token = await readDesktopToken(dir);
    if (!ownsServer) {
      const check = await fetch(`http://127.0.0.1:${backend.port}/api/state`, {
        headers: { "X-Desktop-Token": token }, signal: AbortSignal.timeout(3000),
      });
      const state = check.ok ? await check.json() : null;
      if (state?.role !== "admin")
        throw Error("Порт 8080 обслуживает сервер с другой папкой данных. Остановите его и запустите STREAMHUB снова; данные удалять не нужно.");
    }
    await runCaptureSync(token);
    captureTimer=setInterval(()=>{ void runCaptureSync(token); },5000);
    const brandIcon = nativeImage.createFromPath(path.join(__dirname, "streamhub-logo.png"));
    win = new BrowserWindow({ width: 1600, height: 960, minWidth: 800, minHeight: 600, icon: brandIcon, backgroundColor: "#101519", webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    win.setMenuBarVisibility(false);
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const target = new URL(url);
        if (["http:", "https:"].includes(target.protocol)) shell.openExternal(target.href);
      } catch {}
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => { if (new URL(url).origin !== `http://127.0.0.1:${backend.port}`) event.preventDefault(); });
    await win.loadURL(`http://127.0.0.1:${backend.port}/#bootstrap=${encodeURIComponent(token)}`);
    win.on("close", event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    const icon = brandIcon.resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("STREAMHUB — сервер работает");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Открыть STREAMHUB", click: () => win.show() }, { label: "Папка данных и пароли", click: () => shell.openPath(dir) }, { label: "Запускать панель при входе Windows", type: "checkbox", checked: app.getLoginItemSettings().openAtLogin, click: item => app.setLoginItemSettings({ openAtLogin: item.checked }) }, { type: "separator" }, { label: "Завершить STREAMHUB", click: () => app.quit() }]));
    tray.on("double-click", () => win.show());
  }).catch(error => { dialog.showErrorBox("STREAMHUB", error.message); app.exit(1); });
  app.on("before-quit", event => { if (!quitting && backend) { event.preventDefault(); quitting = true;clearInterval(captureTimer);for(const item of captureProcesses.values())item.process.kill("SIGKILL");captureProcesses.clear(); (ownsServer ? backend.close() : Promise.resolve()).finally(() => app.quit()); } });
}
