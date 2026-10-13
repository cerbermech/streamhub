'use strict';
const $=s=>document.querySelector(s), id=location.pathname.split('/').pop(), M=StudioModel;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
let state,draft,revision,selected=0,epoch=0,savedEpoch=-1,previewTimer,queue=Promise.resolve(),taking=false,disposed=false,previewConfig=null,movingLayer=null;
const players=new Map();
async function api(url,method='GET',body){const r=await fetch(url,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||'Ошибка сервера '+r.status);return data;}
function message(text,error=false){$('#message').textContent=text;$('#message').classList.toggle('error',error);}
function enqueue(fn){const next=queue.then(()=>{if(!disposed)return fn();});queue=next.catch(()=>{});return next;}
function changed(){epoch++;$('#status').textContent='Есть изменения · обновляем предпросмотр';$('#take').disabled=true;clearTimeout(previewTimer);previewTimer=setTimeout(()=>requestPreview(),650);updateCaption();}
function killPlayer(key){const old=players.get(key);if(old){clearTimeout(old.timer);old.hls?.destroy();old.video.pause();old.video.removeAttribute('src');old.video.load();players.delete(key);}}
function play(key,url){
 killPlayer(key);const video=$('#'+key), overlay=$('#'+key+'Overlay'), label=$('#'+key+'State');overlay.hidden=false;overlay.textContent='Подключение к видео…';label.textContent='Подключение…';
 if(!url){overlay.textContent='Канал остановлен';label.textContent='Не в эфире';return;}
 const record={video,hls:null,timer:null,stamp:epoch};players.set(key,record);
 const fail=text=>{if(players.get(key)!==record)return;overlay.hidden=false;overlay.textContent=text;label.textContent='Ошибка подключения';if(key==='preview'){$('#retryPreview').hidden=false;$('#take').disabled=true;}};
 const start=()=>video.play().catch(e=>{if(e.name!=='AbortError')fail('Нажмите ▶ для запуска видео');});
 video.onplaying=()=>{if(players.get(key)!==record)return;clearTimeout(record.timer);overlay.hidden=true;label.textContent=key==='preview'?'Готово':'В эфире';if(key==='preview'){$('#retryPreview').hidden=true;if(record.stamp===epoch){$('#take').disabled=false;$('#status').textContent='Черновик готов к эфиру';}}};
 video.onerror=()=>fail('Видео не загрузилось. Повторите подключение.');
 record.timer=setTimeout(()=>fail('Нет видеокадров. Проверьте источники или повторите подключение.'),30000);
 const fresh=url+(url.includes('?')?'&':'?')+'v='+Date.now();
 if(window.Hls?.isSupported()){
  const h=new Hls({liveSyncDurationCount:2,maxBufferLength:6,backBufferLength:0,manifestLoadingMaxRetry:5,levelLoadingMaxRetry:5});record.hls=h;
  h.on(Hls.Events.MANIFEST_PARSED,start);
  let mediaRetry=false;h.on(Hls.Events.ERROR,(_e,data)=>{if(!data.fatal)return;if(data.type===Hls.ErrorTypes.MEDIA_ERROR&&!mediaRetry){mediaRetry=true;h.recoverMediaError();}else fail('Поток недоступен: '+data.details);});
  h.attachMedia(video);h.loadSource(fresh);
 }else if(video.canPlayType('application/vnd.apple.mpegurl')){video.src=fresh;video.onloadedmetadata=start;}else fail('Этот браузер не поддерживает HLS.');
}
function sourcesOptions(query=''){const current=draft.slots[selected];return '<option value="">Пустой слой</option>'+state.sources.filter(s=>s.id===current||s.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))).map(s=>'<option value="'+esc(s.id)+'" '+(s.id===current?'selected':'')+'>'+esc(s.name)+'</option>').join('');}
function inspector(){const style=draft.captionStyles[selected];$('#selectedNumber').textContent='Слой '+(selected+1);$('#sourceSearch').value='';$('#selectedSource').innerHTML=sourcesOptions();$('#selectedCaption').value=draft.captions[selected]||'';$('#captionAuto').checked=draft.captionAuto[selected];$('#captionEnabled').checked=draft.captionEnabled[selected];$('#selectedCaptionPosition').value=style.position;$('#selectedCaptionSize').value=style.size;$('#selectedCaptionBackground').checked=style.background;$('#fitContain').classList.toggle('active',draft.fits[selected]==='contain');$('#fitCover').classList.toggle('active',draft.fits[selected]==='cover');$('#remove').disabled=draft.size<=1;}
function sourceName(i){return state.sources.find(s=>s.id===draft.slots[i])?.name||'Пустой слой';}
function updateCaption(){const el=$('.layer[data-i="'+selected+'"] .layer-name');if(el)el.textContent=M.caption(draft,selected,state.sources)||sourceName(selected);}
function selectLayer(i){selected=i;$('#stage').querySelectorAll('.layer').forEach(el=>el.classList.toggle('selected',+el.dataset.i===i));$('#layers').querySelectorAll('button').forEach(el=>el.classList.toggle('active',+el.dataset.i===i));inspector();renderStage();}
function renderStage(){
 const stage=$('#stage');stage.dataset.mode=draft.placementMode;stage.innerHTML=draft.geometry.map((g,i)=>'<div class="layer '+(i===selected?'selected':'')+'" data-i="'+i+'" tabindex="0" role="button" aria-label="Слой '+(i+1)+': '+esc(sourceName(i))+'" style="left:'+g.x+'%;top:'+g.y+'%;width:'+g.w+'%;height:'+g.h+'%;z-index:'+(i+1)+'"><canvas class="layer-thumb" data-thumb="'+i+'"></canvas><span class="layer-number">'+(i+1)+'</span><span class="layer-name">'+esc(M.caption(draft,i,state.sources)||sourceName(i))+'</span>'+(draft.placementMode==='free'&&i===selected?['nw','ne','sw','se'].map(c=>'<i class="handle" data-corner="'+c+'"></i>').join(''):'')+'</div>').join('');
 stage.querySelectorAll('.layer').forEach(el=>{
  el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectLayer(+el.dataset.i);}};
  el.onpointerdown=e=>{
   if(e.button!==0||taking)return;e.preventDefault();const i=+el.dataset.i,corner=e.target.dataset.corner;
   if(i!==selected){selected=i;inspector();$('#layers').querySelectorAll('button').forEach(row=>row.classList.toggle('active',+row.dataset.i===i));stage.querySelectorAll('.layer').forEach(row=>row.classList.toggle('selected',+row.dataset.i===i));}
   if(draft.placementMode!=='free'){renderStage();return;}
   const origin={...draft.geometry[i]},px=e.clientX,py=e.clientY,box=stage.getBoundingClientRect();el.setPointerCapture(e.pointerId);let moved=false;
   const move=p=>{if(Math.abs(p.clientX-px)+Math.abs(p.clientY-py)<3&&!moved)return;moved=true;draft.geometry[i]=M.move(origin,(p.clientX-px)/box.width*100,(p.clientY-py)/box.height*100,corner);const g=draft.geometry[i];Object.assign(el.style,{left:g.x+'%',top:g.y+'%',width:g.w+'%',height:g.h+'%'});};
   const finish=()=>{el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',finish);el.removeEventListener('pointercancel',finish);if(el.hasPointerCapture(e.pointerId))el.releasePointerCapture(e.pointerId);if(moved)changed();renderStage();};
   el.addEventListener('pointermove',move);el.addEventListener('pointerup',finish);el.addEventListener('pointercancel',finish);
  };
 });
 $('#stageHint').textContent=draft.placementMode==='free'?'Двигайте слой; тяните углы для изменения размера':'Выберите камеру для настройки. Для перемещения включите свободное размещение.';
 drawThumbnails();
}
function renderList(){ $('#layerCount').textContent=draft.size;$('#layers').innerHTML=draft.slots.map((slot,i)=>'<button draggable="true" class="layer-row '+(i===selected?'active':'')+'" data-i="'+i+'"><span class="order">⋮⋮</span><span class="dot '+(state.sources.find(s=>s.id===slot)?.status==='online'?'online':'')+'"></span><span class="name">'+(i+1)+'. '+esc(sourceName(i))+'</span><span>›</span></button>').join('');$('#layers').querySelectorAll('button').forEach(el=>{el.onclick=()=>selectLayer(+el.dataset.i);el.ondragstart=e=>{movingLayer=+el.dataset.i;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(movingLayer));};el.ondragover=e=>e.preventDefault();el.ondragend=()=>movingLayer=null;el.ondrop=e=>{e.preventDefault();const target=+el.dataset.i;if(movingLayer===null||target===movingLayer)return;for(const key of ['slots','fits','captions','captionStyles','captionAuto','captionEnabled','backups',...(draft.placementMode==='free'?['geometry']:[])]){const list=draft[key];if(list){const item=list.splice(movingLayer,1)[0];list.splice(target,0,item);}}selected=target;movingLayer=null;changed();render();};});}
function render(){renderStage();renderList();inspector();$('#gridMode').classList.toggle('active',draft.placementMode==='grid');$('#freeMode').classList.toggle('active',draft.placementMode==='free');$('#presets').querySelectorAll('button').forEach(b=>b.classList.toggle('active',draft.size===+b.dataset.preset));$('#footerInfo').textContent='STREAMHUB 1.6.6 · '+draft.size+' слоёв · '+draft.quality+' · '+draft.fps+' FPS';}
function drawThumbnails(){const video=$('#preview');if(!previewConfig||video.readyState<2)return;$('#stage').querySelectorAll('canvas').forEach(canvas=>{const i=+canvas.dataset.thumb;if(previewConfig.slots[i]!==draft.slots[i])return;const g=previewConfig.geometry[i];if(!g)return;canvas.width=240;canvas.height=135;try{canvas.getContext('2d').drawImage(video,g.x/100*video.videoWidth,g.y/100*video.videoHeight,g.w/100*video.videoWidth,g.h/100*video.videoHeight,0,0,240,135);}catch{}});}
async function store(snapshot,stamp){const result=await api('/api/channels/'+id+'/draft','PUT',{revision,config:snapshot});revision=result.revision;if(epoch===stamp)savedEpoch=stamp;return result;}
function requestPreview(){clearTimeout(previewTimer);return enqueue(async()=>{
 const stamp=epoch,snapshot=structuredClone(draft);$('#previewState').textContent='Обновляется…';$('#status').textContent='Запускаем предпросмотр…';$('#take').disabled=true;
 try{if(savedEpoch!==stamp)await store(snapshot,stamp);const result=await api('/api/channels/'+id+'/preview-draft','POST',{revision});if(stamp!==epoch){previewTimer=setTimeout(requestPreview,100);return;}previewConfig=snapshot;play('preview',result.hls);$('#status').textContent='Получаем видеокадры предпросмотра…';message('Изменения применены к черновику; подключаем видео');}
 catch(e){$('#previewState').textContent='Ошибка';$('#previewOverlay').hidden=false;$('#previewOverlay').textContent=e.message;$('#retryPreview').hidden=false;message(e.message,true);$('#status').textContent='Предпросмотр не готов';}
 });}
async function take(){if(taking)return;taking=true;clearTimeout(previewTimer);document.querySelectorAll('.shell input,.shell select,.shell button').forEach(el=>el.disabled=true);message('Передаём черновик в эфир…');
 try{await enqueue(async()=>{const stamp=epoch,snapshot=structuredClone(draft);if(savedEpoch!==stamp)await store(snapshot,stamp);const result=await api('/api/channels/'+id+'/take','POST',{revision});revision=result.revision;savedEpoch=stamp;play('program',result.hls);$('#status').textContent='Изменения в эфире';message('Черновик применён. Подключаем обновлённый эфир.');});}
 catch(e){message(e.message,true);$('#status').textContent='Не удалось применить черновик';}
 finally{taking=false;document.querySelectorAll('.shell input,.shell select,.shell button').forEach(el=>el.disabled=false);$('#remove').disabled=draft.size<=1;}
}
function resize(n,free=false){draft.size=n;for(const key of ['slots','fits','captions','captionStyles','captionAuto','captionEnabled','backups']){const old=draft[key]||[];draft[key]=Array.from({length:n},(_,i)=>old[i]??({slots:null,fits:'cover',captions:'',captionStyles:{position:'bottom-left',size:'medium',background:true},captionAuto:true,captionEnabled:true,backups:null}[key]));}draft.geometry=M.grid(n);draft.placementMode=free?'free':'grid';selected=Math.min(selected,n-1);changed();render();}
function form(){for(const name of ['quality','fps','bitrate'])$('#'+name).value=draft[name];$('#titleInput').value=draft.graphics.title;$('#clockInput').checked=draft.graphics.clock;$('#logoInput').innerHTML='<option value="">Нет</option>'+state.logos.map(l=>'<option value="'+esc(l.id)+'">'+esc(l.name)+'</option>').join('');$('#logoInput').value=draft.graphics.logoId||'';render();}
function bind(){
 $('#sourceSearch').oninput=e=>$('#selectedSource').innerHTML=sourcesOptions(e.target.value);
 $('#selectedSource').onchange=e=>{draft.slots[selected]=e.target.value||null;if(draft.captionAuto[selected])draft.captions[selected]=sourceName(selected)==='Пустой слой'?'':sourceName(selected).slice(0,80);changed();render();};
 $('#selectedCaption').oninput=e=>{draft.captions[selected]=e.target.value;draft.captionAuto[selected]=false;$('#captionAuto').checked=false;changed();};
 $('#captionAuto').onchange=e=>{draft.captionAuto[selected]=e.target.checked;if(e.target.checked)draft.captions[selected]=state.sources.find(s=>s.id===draft.slots[selected])?.name.slice(0,80)||'';$('#selectedCaption').value=draft.captions[selected];changed();};
 $('#restoreCaption').onclick=()=>{$('#captionAuto').checked=true;$('#captionAuto').dispatchEvent(new Event('change'));};
 $('#captionEnabled').onchange=e=>{draft.captionEnabled[selected]=e.target.checked;changed();};
 for(const [field,key] of [['selectedCaptionPosition','position'],['selectedCaptionSize','size'],['selectedCaptionBackground','background']])$('#'+field).onchange=e=>{draft.captionStyles[selected][key]=key==='background'?e.target.checked:e.target.value;changed();};
 for(const [field,fit] of [['fitContain','contain'],['fitCover','cover']])$('#'+field).onclick=()=>{draft.fits[selected]=fit;changed();inspector();};
 $('#presets').querySelectorAll('button').forEach(b=>b.onclick=()=>resize(+b.dataset.preset));
 $('#gridMode').onclick=$('#resetGeometry').onclick=()=>{draft.geometry=M.grid(draft.size);draft.placementMode='grid';changed();render();};
 $('#freeMode').onclick=()=>{draft.placementMode='free';changed();render();};
 $('#add').onclick=()=>{if(draft.size>=16){message('В студии поддерживается до 16 слоёв',true);return;}const n=draft.size;resize(n+1,true);selected=n;render();};
 $('#remove').onclick=()=>{if(draft.size<=1)return;for(const key of ['slots','fits','captions','captionStyles','captionAuto','captionEnabled','backups','geometry'])draft[key]?.splice(selected,1);draft.size--;selected=Math.min(selected,draft.size-1);if(draft.placementMode==='grid')draft.geometry=M.grid(draft.size);changed();render();};
 for(const name of ['quality','fps','bitrate'])$('#'+name).onchange=e=>{draft[name]=name==='quality'?e.target.value:Number(e.target.value);changed();};
 $('#titleInput').oninput=e=>{draft.graphics.title=e.target.value;changed();};$('#clockInput').onchange=e=>{draft.graphics.clock=e.target.checked;changed();};$('#logoInput').onchange=e=>{draft.graphics.logoId=e.target.value||null;changed();};
 $('#logoFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});await api('/api/logos','POST',{name:file.name,data});state=await api('/api/state');form();message('Логотип загружен; выберите его в списке');}catch(e){message(e.message,true);}};
 $('#retryPreview').onclick=requestPreview;$('#take').onclick=take;
 $('#save').onclick=()=>enqueue(async()=>{try{await store(structuredClone(draft),epoch);message('Черновик сохранён');}catch(e){message(e.message,true);}});
 $('#reset').onclick=()=>{if(!confirm('Сбросить черновик до текущего эфира?'))return;enqueue(async()=>{try{await api('/api/channels/'+id+'/draft','DELETE');await loadDraft();requestPreview();}catch(e){message(e.message,true);}});};
}
async function loadDraft(){const data=await api('/api/channels/'+id+'/draft');draft=M.normalize(data.config,state.sources);revision=data.revision;epoch++;savedEpoch=-1;selected=Math.min(selected,draft.size-1);form();if(data.conflict)message('Эфир изменился в другом окне. Сбросьте черновик перед выдачей.',true);}
async function init(){try{state=await api('/api/state');if(state.role!=='admin')throw Error('Студия доступна администратору');const channel=state.channels.find(c=>c.id===id);if(!channel)throw Error('Канал не найден');$('#heading').textContent='Студия — '+channel.name;bind();await loadDraft();play('program',channel.desired?channel.hls:null);requestPreview();setInterval(drawThumbnails,1500);}catch(e){message(e.message,true);$('#status').textContent='Ошибка загрузки студии';$('#take').disabled=true;}}
window.addEventListener('beforeunload',e=>{if(savedEpoch!==epoch){e.preventDefault();e.returnValue='';}});window.addEventListener('pagehide',()=>{disposed=true;clearTimeout(previewTimer);killPlayer('preview');killPlayer('program');});init();
