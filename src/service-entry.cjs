"use strict";
const path=require("node:path"),{startServer}=require("./server.cjs");
const arg=process.argv.find(x=>x.startsWith("--data-dir="));
startServer({dataDir:arg?arg.slice(11):process.env.VIDEOWALL_DATA,serviceMode:true}).then(app=>{const stop=()=>app.close().finally(()=>process.exit(0));process.on("SIGTERM",stop);process.on("SIGINT",stop)}).catch(e=>{console.error(e);process.exit(1)});
