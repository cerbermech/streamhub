"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { RecordingManager } = require("../src/recording.cjs");
const { BackupManager, applyPending } = require("../src/backup.cjs");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "streamhub-audit-"));
test("source recording follows UDP or TCP; channel recording stays local TCP", () => {
  const dir = temp();
  try {
    let transport = "udp";
    const recordings = new RecordingManager({dir, ffmpeg:"ffmpeg", rtspPort:8554,
      getSource:()=>({url:"rtsp://camera/live",transport}),
      getChannel:()=>({id:"channel-id"}), getSettings:()=>({}),setSettings:()=>{},log:()=>{}});
    assert.deepEqual(recordings.input({type:"source",targetId:"camera"}).slice(0,2),["-rtsp_transport","udp"]);
    transport="tcp";
    assert.deepEqual(recordings.input({type:"source",targetId:"camera"}).slice(0,2),["-rtsp_transport","tcp"]);
    assert.deepEqual(recordings.input({type:"channel",targetId:"channel-id"}).slice(0,2),["-rtsp_transport","tcp"]);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("restore rejects invalid contents before overwriting installed data", () => {
  const dir=temp();
  try {
    const sqlite=Buffer.from("SQLite format 3\0existing-data");
    fs.writeFileSync(path.join(dir,"wall.sqlite"),sqlite);
    const backup=new BackupManager(dir,{exec:()=>{}},()=>{});
    const pack=(files)=>zlib.gzipSync(JSON.stringify({magic:"VIDEOWALL_BACKUP_1",files}));
    assert.throws(()=>backup.import(pack({"wall.sqlite":sqlite.toString("base64"),"../escape":"YQ=="})),/Недопустимый/);
    const invalid=path.join(dir,"backups","bad.vwbak");
    fs.writeFileSync(invalid,pack({"wall.sqlite":"YQ=="}));
    fs.writeFileSync(path.join(dir,"restore.pending"),invalid);
    assert.throws(()=>applyPending(dir),/Повреждённая база/);
    assert.deepEqual(fs.readFileSync(path.join(dir,"wall.sqlite")),sqlite);
    fs.writeFileSync(invalid,pack({"wall.sqlite":sqlite.toString("base64")}));
    assert.equal(applyPending(dir),true);
    assert.equal(fs.existsSync(path.join(dir,"restore.pending")),false);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
