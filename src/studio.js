"use strict";
const $=s=>document.querySelector(s),esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]),id=location.pathname.split("/").pop();
let state,draft,revision,selected=0,dirty=false,busy=false;const mediaPlayers=new WeakMap();
async function api(url,opt={}){const r=await fetch(url,{headers:{"Content-Type":"application/json"},...opt}),b=await r.json().catch(()=>({}));if(!r.ok)throw Error(b.error||"Ошибка");return b}
function grid(n){const cols=Math.ceil(Math.sqrt(n)),rows=Math.ceil(n/cols);return Array.from({length:n},(_,i)=>({x:i%cols*100/cols,y:Math.floor(i/cols)*100/rows,w:100/cols,h:100/rows}))}
function defaults(c){c.geometry||=grid(c.size);c.captions||=Array(c.size).fill("");c.captionStyles=Array.from({length:c.size},(_,i)=>({position:"bottom-left",size:"medium",background:true,...(c.captionStyles?.[i]||{})}));c.graphics||={title:"",clock:false,logoId:null,x:2,y:2,width:18,height:18};c.fits||=Array(c.size).fill("cover");return c}
function changed(){dirty=true;$("#status").textContent="Есть несохранённые изменения"}
function play(video,url){const old=mediaPlayers.get(video);if(old){old.destroy();mediaPlayers.delete(video)}video.removeAttribute("src");video.load();if(!url)return;if(Hls.isSupported()){const h=new Hls({liveSyncDurationCount:2,maxBufferLength:6});h.loadSource(url);h.attachMedia(video);mediaPlayers.set(video,h)}else{video.src=url;video.play().catch(()=>{})}}
function placeCaption(el,s){
  const [v,h]=(s.position||"bottom-left").split("-");
  const outputWidth=draft.quality==="1080p"?1920:draft.quality==="360p"?640:1280;
  const scale=Math.max(0.01,$("#stage").clientWidth/outputWidth);
  const size=s.size==="large"?Math.max(20,Math.round(outputWidth/48)):
    s.size==="small"?Math.max(13,Math.round(outputWidth/82)):
    Math.max(16,Math.round(outputWidth/64));
  const offset=(12*scale).toFixed(2)+"px";
  Object.assign(el.style,{left:"auto",right:"auto",top:"auto",bottom:"auto",transform:"none",
    fontSize:(size*scale).toFixed(2)+"px",padding:s.background===false?"0":(7*scale).toFixed(2)+"px"});
  el.style[v]=offset;
  if(h==="left")el.style.left=offset;
  if(h==="right")el.style.right=offset;
  if(h==="center"){el.style.left="50%";el.style.transform="translateX(-50%)"}
  el.dataset.size=s.size||"medium";
  el.dataset.background=s.background===false?"off":"on";
}
function syncSelectedEditor(){const style=draft.captionStyles[selected]||{position:"bottom-left",size:"medium",background:true};$("#selectedCaption").value=draft.captions[selected]||"";$("#selectedCaptionPosition").value=style.position||"bottom-left";$("#selectedCaptionSize").value=style.size||"medium";$("#selectedCaptionBackground").checked=style.background!==false}
function updateLayerCaption(i) {
  const caption = $(`.layer[data-i="${i}"] .layer-caption`);
  if (!caption) return;
  caption.textContent = draft.captions[i] || "";
  placeCaption(caption, draft.captionStyles[i]);
}
function selectLayer(i) {
  if (i === selected) return;
  selected = i;
  document.querySelectorAll("#stage .layer").forEach(el => el.classList.toggle("selected", +el.dataset.i === i));
  document.querySelectorAll("#layers .layer-row").forEach(el => el.classList.toggle("active", +el.dataset.selectLayer === i));
  syncSelectedEditor();
}
function renderStage() {
  const stage = $("#stage");
  stage.querySelectorAll(".layer").forEach(el => el.remove());
  draft.geometry.forEach((g, i) => {
    const el = document.createElement("div"), caption = document.createElement("span"), handle = document.createElement("i");
    el.className = "layer" + (i === selected ? " selected" : "");
    el.dataset.i = i;
    el.title = state.sources.find(s => s.id === draft.slots[i])?.name || "Пустой слой";
    Object.assign(el.style, {left:g.x+"%",top:g.y+"%",width:g.w+"%",height:g.h+"%",zIndex:i+1});
    caption.className = "layer-caption";
    handle.className = "handle";
    el.append(caption,handle);
    el.addEventListener("click", () => selectLayer(i));
    drag(el,i);
    stage.append(el);
    updateLayerCaption(i);
  });
  $("#title").textContent=draft.graphics.title;
  $("#clock").textContent=draft.graphics.clock?new Date().toLocaleTimeString():"";
  const logo=$("#logo");
  logo.hidden=!draft.graphics.logoId;
  if(!logo.hidden){logo.src=`/api/logos/${draft.graphics.logoId}.png`;Object.assign(logo.style,{left:draft.graphics.x+"%",top:draft.graphics.y+"%",width:draft.graphics.width+"%",height:draft.graphics.height+"%"})}
}
function drag(el,i) {
  el.addEventListener("pointerdown", e => {
    if(e.button!==0)return;
    e.preventDefault();
    selectLayer(i);
    const resize=e.target.classList.contains("handle"), origin={x:e.clientX,y:e.clientY,...draft.geometry[i]};
    const box=$("#stage").getBoundingClientRect();
    if(!box.width||!box.height)return;
    el.setPointerCapture(e.pointerId);
    const move=p=>{
      const dx=(p.clientX-origin.x)/box.width*100,dy=(p.clientY-origin.y)/box.height*100,g=draft.geometry[i];
      if(resize){g.w=Math.max(5,Math.min(100-g.x,origin.w+dx));g.h=Math.max(5,Math.min(100-g.y,origin.h+dy))}
      else{g.x=Math.max(0,Math.min(100-g.w,origin.x+dx));g.y=Math.max(0,Math.min(100-g.h,origin.y+dy))}
      Object.assign(el.style,{left:g.x+"%",top:g.y+"%",width:g.w+"%",height:g.h+"%"});
      changed();
    };
    const finish=()=>{el.removeEventListener("pointermove",move);el.removeEventListener("pointerup",finish);el.removeEventListener("pointercancel",finish);if(el.hasPointerCapture(e.pointerId))el.releasePointerCapture(e.pointerId)};
    el.addEventListener("pointermove",move);
    el.addEventListener("pointerup",finish);
    el.addEventListener("pointercancel",finish);
  });
}
function renderList(){const positions=[["bottom-left","Снизу слева"],["bottom-center","Снизу по центру"],["bottom-right","Снизу справа"],["top-left","Сверху слева"],["top-center","Сверху по центру"],["top-right","Сверху справа"]];$("#layers").innerHTML=draft.slots.map((slot,i)=>{const s=draft.captionStyles[i];return `<div class="layer-row ${i===selected?"active":""}" data-select-layer="${i}"><div class="layer-row__title"><b>Слой ${i+1}</b><span>${i===selected?"Выбран":""}</span></div><input type="search" data-source-search="${i}" placeholder="Поиск камеры…" aria-label="Поиск камеры для слоя ${i+1}"><select data-source="${i}"><option value="">Пусто</option>${state.sources.map(x=>`<option value="${x.id}" ${x.id===slot?"selected":""}>${esc(x.name)}</option>`).join("")}</select><select data-fit="${i}"><option value="contain" ${draft.fits[i]==="contain"?"selected":""}>Вписать</option><option value="cover" ${draft.fits[i]==="cover"?"selected":""}>Заполнить</option></select><input data-caption="${i}" maxlength="80" placeholder="Подпись" value="${esc(draft.captions[i])}"><div class="caption-options"><select data-caption-position="${i}">${positions.map(([v,l])=>`<option value="${v}" ${s.position===v?"selected":""}>${l}</option>`).join("")}</select><select data-caption-size="${i}"><option value="small" ${s.size==="small"?"selected":""}>Мелкая</option><option value="medium" ${s.size==="medium"?"selected":""}>Средняя</option><option value="large" ${s.size==="large"?"selected":""}>Крупная</option></select><label class="check"><input type="checkbox" data-caption-background="${i}" ${s.background!==false?"checked":""}> Фон</label></div></div>`}).join("");document.querySelectorAll("[data-select-layer]").forEach(row=>row.onclick=e=>{if(e.target.closest("input,select,label"))return;selectLayer(+row.dataset.selectLayer)});document.querySelectorAll("[data-source-search]").forEach(input => input.oninput = () => {
  const select = document.querySelector(`[data-source="${input.dataset.sourceSearch}"]`);
  const current = select.value, query = input.value.trim().toLocaleLowerCase("ru");
  select.innerHTML = '<option value="">Пусто</option>' + state.sources.filter(source => source.id === current || (source.name + " " + (source.description || "")).toLocaleLowerCase("ru").includes(query)).map(source => `<option value="${source.id}" ${source.id === current ? "selected" : ""}>${esc(source.name)}</option>`).join("");
});document.querySelectorAll("[data-source]").forEach(x=>x.onchange=()=>{draft.slots[+x.dataset.source]=x.value||null;changed();renderStage()});document.querySelectorAll("[data-fit]").forEach(x=>x.onchange=()=>{draft.fits[+x.dataset.fit]=x.value;changed()});document.querySelectorAll("[data-caption]").forEach(x=>x.oninput=()=>{const i=+x.dataset.caption;draft.captions[i]=x.value;updateLayerCaption(i);if(i===selected)$("#selectedCaption").value=x.value;changed()});document.querySelectorAll("[data-caption-position]").forEach(x=>x.onchange=()=>{draft.captionStyles[+x.dataset.captionPosition].position=x.value;changed();updateLayerCaption(+x.dataset.captionPosition);if(+x.dataset.captionPosition===selected)syncSelectedEditor()});document.querySelectorAll("[data-caption-size]").forEach(x=>x.onchange=()=>{draft.captionStyles[+x.dataset.captionSize].size=x.value;changed();updateLayerCaption(+x.dataset.captionSize);if(+x.dataset.captionSize===selected)syncSelectedEditor()});document.querySelectorAll("[data-caption-background]").forEach(x=>x.onchange=()=>{draft.captionStyles[+x.dataset.captionBackground].background=x.checked;changed();updateLayerCaption(+x.dataset.captionBackground);if(+x.dataset.captionBackground===selected)syncSelectedEditor()});syncSelectedEditor()}
function render(){renderStage();renderList()}
function bind(){new ResizeObserver(()=>{if(draft)draft.geometry.forEach((_,i)=>updateLayerCaption(i))}).observe($("#stage"));for(const x of ["titleInput","clockInput","quality","fps","bitrate","logoInput"])$("#"+x).onchange=sync;$("#selectedCaption").oninput=e=>{draft.captions[selected]=e.target.value;const inline=document.querySelector(`[data-caption="${selected}"]`);if(inline)inline.value=e.target.value;changed();updateLayerCaption(selected)};$("#selectedCaptionPosition").onchange=e=>{draft.captionStyles[selected].position=e.target.value;changed();updateLayerCaption(selected)};$("#selectedCaptionSize").onchange=e=>{draft.captionStyles[selected].size=e.target.value;changed();updateLayerCaption(selected)};$("#selectedCaptionBackground").onchange=e=>{draft.captionStyles[selected].background=e.target.checked;changed();updateLayerCaption(selected)};document.querySelectorAll("[data-preset]").forEach(b=>b.onclick=()=>{const p=b.dataset.preset;if(p==="pip"){draft.size=2;draft.geometry=[{x:0,y:0,w:100,h:100},{x:68,y:65,w:29,h:30}]}else{draft.size=+p;draft.geometry=grid(draft.size)}draft.slots=Array.from({length:draft.size},(_,i)=>draft.slots[i]||null);draft.fits=Array.from({length:draft.size},(_,i)=>draft.fits[i]||"cover");draft.captions=Array.from({length:draft.size},(_,i)=>draft.captions[i]||"");draft.captionStyles=Array.from({length:draft.size},(_,i)=>draft.captionStyles[i]||{position:"bottom-left",size:"medium",background:true});selected=Math.min(selected,draft.size-1);changed();render()});$("#add").onclick=()=>{if(draft.size>=16)return msg("Допускается не более 16 слоёв",true);draft.size++;draft.slots.push(null);draft.fits.push("cover");draft.captions.push("");draft.captionStyles.push({position:"bottom-left",size:"medium",background:true});draft.geometry.push({x:65,y:65,w:30,h:30});selected=draft.size-1;changed();render()};$("#remove").onclick=()=>{if(draft.size<=1)return;for(const a of [draft.slots,draft.fits,draft.captions,draft.captionStyles,draft.geometry])a.splice(selected,1);draft.size--;selected=Math.min(selected,draft.size-1);changed();render()};$("#save").onclick=save;$("#show").onclick=preview;$("#take").onclick=take;$("#reset").onclick=reset;$("#logoFile").onchange=upload}
function sync(){draft.graphics.title=$("#titleInput").value;draft.graphics.clock=$("#clockInput").checked;draft.graphics.logoId=$("#logoInput").value||null;draft.quality=$("#quality").value;draft.fps=+$("#fps").value;draft.bitrate=+$("#bitrate").value;changed();renderStage()}
function form(){$("#titleInput").value=draft.graphics.title;$("#clockInput").checked=draft.graphics.clock;$("#quality").value=draft.quality;$("#fps").value=draft.fps;$("#bitrate").value=draft.bitrate;$("#logoInput").innerHTML='<option value="">Нет</option>'+state.logos.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join("");$("#logoInput").value=draft.graphics.logoId||"";render()}
async function execute(label,fn){if(busy)return;busy=true;document.querySelectorAll(".actions button").forEach(b=>b.disabled=true);msg(label);try{return await fn()}catch(e){msg(e.message,true)}finally{busy=false;document.querySelectorAll(".actions button").forEach(b=>b.disabled=false)}}
async function store(){const x=await api(`/api/channels/${id}/draft`,{method:"PUT",body:JSON.stringify({revision,config:draft})});revision=x.revision;dirty=false;$("#status").textContent="Черновик сохранён"}
async function save(){execute("Сохраняем черновик…",async()=>{await store();msg("Черновик сохранён")})}
async function preview(){execute("Запускаем предпросмотр…",async()=>{if(dirty)await store();const x=await api(`/api/channels/${id}/preview-draft`,{method:"POST",body:"{}"});play($("#preview"),x.hls);$("#status").textContent="Предпросмотр запущен (360p · 10 FPS)";msg("Предпросмотр запущен")})}
async function take(){execute("Передаём в эфир…",async()=>{if(dirty)await store();const x=await api(`/api/channels/${id}/take`,{method:"POST",body:JSON.stringify({revision})});revision=x.revision;$("#status").textContent="Изменения в эфире";msg("Черновик передан в эфир")})}
async function reset(){if(dirty&&!confirm("Сбросить несохранённые изменения?"))return;execute("Сбрасываем черновик…",async()=>{const x=await api(`/api/channels/${id}/draft`,{method:"DELETE"});revision=x.revision;await loadDraft();msg("Черновик сброшен")})}
async function upload(){const f=$("#logoFile").files[0];if(!f)return;const data=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f)});await api("/api/logos",{method:"POST",body:JSON.stringify({name:f.name,data})});state=await api("/api/state");$("#logoInput").innerHTML='<option value="">Нет</option>'+state.logos.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join("");msg("Логотип загружен")}
function msg(s,bad=false){$("#message").className=bad?"error":"";$("#message").textContent=s}
async function loadDraft(){const x=await api(`/api/channels/${id}/draft`);draft=defaults(x.config);revision=x.revision;dirty=false;form();$("#status").textContent="Черновик загружен";if(x.conflict)msg("Эфир изменился: сбросьте или пересоздайте черновик",true)}
async function init(){try{state=await api("/api/state");if(state.role!=="admin")throw Error("Студия доступна администратору");const c=state.channels.find(x=>x.id===id);if(!c)throw Error("Канал не найден");$("#heading").textContent="Студия — "+c.name;bind();await loadDraft();play($("#program"),c.hls);setInterval(()=>{if(draft.graphics.clock)$("#clock").textContent=new Date().toLocaleTimeString()},1000)}catch(e){msg(e.message,true)}}
window.addEventListener("beforeunload",e=>{if(dirty){e.preventDefault();e.returnValue=""}});init();
