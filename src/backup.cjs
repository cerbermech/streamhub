"use strict";
const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib"), crypto = require("node:crypto");
const MAGIC = "VIDEOWALL_BACKUP_1";
const MAX_ARCHIVE = 100 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_FILES = 2000;

function decodeBackup(data) {
  if (!Buffer.isBuffer(data) || data.length > MAX_ARCHIVE)
    throw Error("Файл резервной копии слишком большой");
  let payload;
  try {
    payload = JSON.parse(zlib.gunzipSync(data, { maxOutputLength: MAX_EXPANDED }));
  } catch {
    throw Error("Повреждённая или слишком большая резервная копия");
  }
  if (!payload || payload.magic !== MAGIC || !payload.files ||
      typeof payload.files !== "object" || Array.isArray(payload.files))
    throw Error("Неверный формат резервной копии");
  const entries = Object.entries(payload.files);
  if (!entries.length || entries.length > MAX_FILES || !Object.hasOwn(payload.files, "wall.sqlite"))
    throw Error("Неверный состав резервной копии");
  const files = new Map();
  let total = 0;
  for (const [name, encoded] of entries) {
    if (!(["wall.sqlite", "secret.key", "first-login.txt", "desktop.token"].includes(name) ||
        /^graphics\/[a-zA-Z0-9_.-]+\.png$/.test(name)) ||
        typeof encoded !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))
      throw Error("Недопустимый файл в резервной копии");
    const bytes = Buffer.from(encoded, "base64");
    total += bytes.length;
    if (bytes.length > MAX_EXPANDED || total > MAX_EXPANDED)
      throw Error("Распакованная копия слишком большая");
    files.set(name, bytes);
  }
  if (!files.get("wall.sqlite")?.subarray(0, 16).equals(Buffer.from("SQLite format 3\0")))
    throw Error("Повреждённая база данных в резервной копии");
  return files;
}

function applyPending(dir) {
  const marker = path.join(dir, "restore.pending");
  if (!fs.existsSync(marker)) return false;
  const file = fs.readFileSync(marker, "utf8").trim();
  if (fs.statSync(file).size > MAX_ARCHIVE) throw Error("Файл резервной копии слишком большой");
  const files = decodeBackup(fs.readFileSync(file));
  for (const [name, data] of files) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: name.includes("login") || name.includes("token") || name === "secret.key" ? 0o600 : 0o644 });
  }
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(path.join(dir, "wall.sqlite" + suffix), { force: true });
  fs.rmSync(marker, { force: true });
  return true;
}

class BackupManager {
  constructor(dir, db, log) { this.dir=dir; this.db=db; this.log=log; this.folder=path.join(dir,"backups"); fs.mkdirSync(this.folder,{recursive:true}); }
  list() { return fs.readdirSync(this.folder).filter(x=>x.endsWith(".vwbak")).map(id=>{const s=fs.statSync(path.join(this.folder,id));return{id,createdAt:s.mtime.toISOString(),size:s.size}}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)); }
  resolve(id) { if(!/^[a-zA-Z0-9_.-]+\.vwbak$/.test(id)) throw Error("Неверное имя копии"); const f=path.join(this.folder,id); if(!fs.existsSync(f))throw Error("Копия не найдена"); return f; }
  create() { this.db.exec("PRAGMA wal_checkpoint(FULL)"); const files={}; for(const n of ["wall.sqlite","secret.key","first-login.txt","desktop.token"]){const f=path.join(this.dir,n);if(fs.existsSync(f))files[n]=fs.readFileSync(f).toString("base64")} const graphics=path.join(this.dir,"graphics"); if(fs.existsSync(graphics))for(const n of fs.readdirSync(graphics).filter(x=>x.endsWith(".png")))files["graphics/"+n]=fs.readFileSync(path.join(graphics,n)).toString("base64"); const id=`videowall-${new Date().toISOString().replace(/[:.]/g,"-")}-${crypto.randomBytes(3).toString("hex")}.vwbak`; fs.writeFileSync(path.join(this.folder,id),zlib.gzipSync(JSON.stringify({magic:MAGIC,createdAt:new Date().toISOString(),files}))); while(this.list().length>10)fs.rmSync(this.resolve(this.list().at(-1).id)); this.log("backup","Резервная копия создана"); return this.list().find(x=>x.id===id); }
  import(data) { decodeBackup(data); const id=`import-${Date.now()}.vwbak`;fs.writeFileSync(path.join(this.folder,id),data);return this.list().find(x=>x.id===id); }
  scheduleRestore(id){const f=this.resolve(id);fs.writeFileSync(path.join(this.dir,"restore.pending"),f,{mode:0o600});this.log("restore","Восстановление подготовлено");return{ok:true,restartRequired:true};}
  remove(id){fs.rmSync(this.resolve(id));return{ok:true};}
  start(){this.timer=setInterval(()=>{const last=this.list()[0];if(!last||Date.now()-Date.parse(last.createdAt)>86400000)try{this.create()}catch(e){this.log("backup",e.message)}},3600000);this.timer.unref?.();}
  close(){clearInterval(this.timer)}
}
module.exports={BackupManager,applyPending};
