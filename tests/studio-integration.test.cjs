const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn,execFile}=require('node:child_process');
test('real RTSP source -> draft HLS -> updated program with geometry and captions',{skip:!process.env.STUDIO_TEST_MEDIAMTX,timeout:120000},async()=>{
 process.env.MEDIAMTX_PATH=process.env.STUDIO_TEST_MEDIAMTX;process.env.MTX_RTSP_PORT='8576';process.env.MTX_HLS_PORT='8896';process.env.MTX_API_PORT='9996';process.env.VIDEOWALL_PASSWORD='StudioTest-Only-2026';
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'streamhub-studio-'));const {startServer}=require('../src/server.cjs');let app,publisher;
 try{
 app=await startServer({port:0,host:'127.0.0.1',dataDir:dir});const origin='http://127.0.0.1:'+app.port;let cookie='';
 async function api(url,method='GET',body){const r=await fetch(origin+url,{method,headers:{'Content-Type':'application/json',Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body)});if(url==='/api/login')cookie=r.headers.get('set-cookie').split(';')[0];const data=await r.json();assert(r.ok,JSON.stringify(data));return data;}
 await api('/api/login','POST',{user:'admin',password:process.env.VIDEOWALL_PASSWORD});
 await new Promise(r=>setTimeout(r,1500));
 publisher=spawn('ffmpeg',['-hide_banner','-loglevel','error','-re','-f','lavfi','-i','color=c=blue:s=640x360:r=10','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-pix_fmt','yuv420p','-g','10','-f','rtsp','-rtsp_transport','tcp','rtsp://127.0.0.1:8576/fixture'],{stdio:['ignore','ignore','pipe']});let errors='';publisher.stderr.on('data',b=>errors+=b);await new Promise(r=>setTimeout(r,1200));assert.equal(publisher.exitCode,null,errors);
 const source=await api('/api/sources','POST',{name:'Тестовая камера',url:'rtsp://127.0.0.1:8576/fixture',quality:'360p'});
 const channel=await api('/api/channels','POST',{name:'Студия тест',slug:'studio-test',size:1,slots:[source.id],quality:'360p',fps:10,bitrate:600,encoder:'libx264'});
 let d=await api('/api/channels/'+channel.id+'/draft');const M=require('../src/studio-model.js');d.config=M.normalize(d.config,[{id:source.id,name:'Тестовая камера'}]);let saved=await api('/api/channels/'+channel.id+'/draft','PUT',{revision:d.revision,config:d.config});
 const preview=await api('/api/channels/'+channel.id+'/preview-draft','POST',{revision:saved.revision});assert(preview.hls.includes('-r'+saved.revision));
 const response=await fetch(origin+preview.hls,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert((await response.text()).includes('#EXTM3U'));
 const take=await api('/api/channels/'+channel.id+'/take','POST',{revision:saved.revision});assert.equal(take.hls,'/live/studio-test/index.m3u8');
 const frame=()=>require('node:util').promisify(execFile)('ffmpeg',['-v','error','-rtsp_transport','tcp','-i','rtsp://127.0.0.1:8576/channel-'+channel.id,'-frames:v','1','-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{timeout:15000,maxBuffer:1000000,encoding:'buffer'}).then(r=>r.stdout);
 const before=await frame();d=await api('/api/channels/'+channel.id+'/draft');d.config.geometry=[{x:10.5,y:10.5,w:60.5,h:70.5}];d.config.placementMode='free';d.config.captions=['НОВАЯ ПОДПИСЬ'];d.config.captionAuto=[false];saved=await api('/api/channels/'+channel.id+'/draft','PUT',{revision:d.revision,config:d.config});await api('/api/channels/'+channel.id+'/take','POST',{revision:saved.revision});const after=await frame();assert.notDeepEqual(after,before);
 const final=await api('/api/channels/'+channel.id+'/draft');assert.equal(final.config.captions[0],'НОВАЯ ПОДПИСЬ');assert.equal(final.config.geometry[0].x,10.5);assert.equal(final.conflict,false);
 if(process.env.STUDIO_TEST_CHROME){
  const {chromium}=require(process.env.STUDIO_TEST_PLAYWRIGHT);const browser=await chromium.launch({executablePath:process.env.STUDIO_TEST_CHROME,args:['--no-sandbox','--disable-dev-shm-usage'],headless:true});
  try{const context=await browser.newContext({viewport:{width:1920,height:1080}});await context.addCookies([{name:'wall',value:cookie.split('=')[1],url:origin}]);const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/studio/'+channel.id);await page.waitForFunction(()=>document.querySelector('#preview').readyState>=2,{},{timeout:30000});
  await page.locator('#selectedCaption').fill('ОХРАНА');await page.waitForFunction(()=>document.querySelector('#status').textContent==='Черновик готов к эфиру',{},{timeout:30000});assert.equal(await page.locator('#captionAuto').isChecked(),false);
  await page.locator('#freeMode').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Черновик готов к эфиру',{},{timeout:30000});
  const box=await page.locator('.layer').first().boundingBox(),stageBox=await page.locator('#stage').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2+25,box.y+box.height/2+15,{steps:5});await page.mouse.up();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Черновик готов к эфиру',{},{timeout:30000});
  await page.locator('#take').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Изменения в эфире',{},{timeout:30000});
  const applied=await api('/api/channels/'+channel.id+'/draft');assert.equal(applied.config.captions[0],'ОХРАНА');assert(Math.abs(applied.config.geometry[0].x-(10.5+25/stageBox.width*100))<.6);
  await page.locator('[data-preset="4"]').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Черновик готов к эфиру',{},{timeout:30000});
  await page.locator('.layer-row[data-i="0"]').dragTo(page.locator('.layer-row[data-i="1"]'));await page.waitForFunction(()=>document.querySelector('#status').textContent==='Черновик готов к эфиру',{},{timeout:30000});
  const reordered=await api('/api/channels/'+channel.id+'/draft');assert.equal(reordered.config.slots[1],source.id);assert.equal(reordered.config.captions[1],'ОХРАНА');
  await page.locator('#restoreCaption').click();await page.waitForFunction(()=>document.querySelector('#status').textContent==='Черновик готов к эфиру',{},{timeout:30000});assert.equal(await page.locator('#selectedCaption').inputValue(),'Тестовая камера');

  for(const width of [1920,1280,820,480]){await page.setViewportSize({width,height:1080});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'Overflow at '+width);await page.screenshot({path:path.join(process.env.STUDIO_TEST_SCREENSHOTS,'studio-'+width+'.png'),fullPage:true});}
  assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 }

 const beforeOutage=await frame();publisher.kill('SIGKILL');await new Promise(r=>publisher.exitCode!==null||publisher.signalCode?r():publisher.once('close',r));await new Promise(r=>setTimeout(r,7000));
 const duringOutage=await frame();assert.notDeepEqual(duringOutage,beforeOutage,'connection label must reach the encoded channel');
 const center=(150*640+200)*3;assert(duringOutage[center+2]>150&&duringOutage[center]<60&&duringOutage[center+1]<60,'camera picture remains blue during the outage instead of no-signal placeholder');
 }finally{if(publisher){publisher.kill('SIGKILL');await new Promise(r=>publisher.exitCode!==null||publisher.signalCode?r():publisher.once('close',r));}if(app)await app.close();fs.rmSync(dir,{recursive:true,force:true});}
});
