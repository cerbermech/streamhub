'use strict';
function validateScene(c,logoExists=()=>false){
 const n=c.size;let geometry=null;
 if(c.geometry!==undefined&&c.geometry!==null){if(!Array.isArray(c.geometry)||c.geometry.length!==n)throw Error('Неверная геометрия слоёв');geometry=c.geometry.map(g=>{const r={x:Number(g.x),y:Number(g.y),w:Number(g.w),h:Number(g.h)};if(Object.values(r).some(v=>!Number.isFinite(v))||r.w<5||r.h<5||r.x<0||r.y<0||r.x+r.w>100.001||r.y+r.h>100.001)throw Error('Слой должен находиться внутри кадра и быть не меньше 5%');return r})}
 const captions=c.captions===undefined?Array(n).fill(''):c.captions;if(!Array.isArray(captions)||captions.length!==n||captions.some(x=>typeof x!=='string'||x.length>80))throw Error('Подписи: не более 80 символов');
 const allowedPositions=new Set(['top-left','top-center','top-right','bottom-left','bottom-center','bottom-right']),allowedSizes=new Set(['small','medium','large']);
 const rawStyles=Array.isArray(c.captionStyles)?c.captionStyles:[];
 const captionStyles=Array.from({length:n},(_,i)=>{const s=rawStyles[i]||{};return{position:allowedPositions.has(s.position)?s.position:'bottom-left',size:allowedSizes.has(s.size)?s.size:'medium',background:s.background!==false}});
 const g=c.graphics||{},graphics={title:typeof g.title==='string'?g.title.trim():'',clock:!!g.clock,logoId:g.logoId||null,x:Number(g.x??2),y:Number(g.y??2),width:Number(g.width??18),height:Number(g.height??18)};if(graphics.title.length>160)throw Error('Заголовок: не более 160 символов');if(graphics.logoId){if(!/^[a-f0-9-]{36}$/.test(graphics.logoId)||!logoExists(graphics.logoId))throw Error('Логотип не найден');if([graphics.x,graphics.y,graphics.width,graphics.height].some(v=>!Number.isFinite(v))||graphics.width<2||graphics.height<2||graphics.x<0||graphics.y<0||graphics.x+graphics.width>100.001||graphics.y+graphics.height>100.001)throw Error('Логотип должен находиться внутри кадра')}
 const captionAuto=Array.from({length:n},(_,i)=>typeof c.captionAuto?.[i]==='boolean'?c.captionAuto[i]:!captions[i]),captionEnabled=Array.from({length:n},(_,i)=>c.captionEnabled?.[i]!==false);
 return{geometry,captions,captionStyles,graphics,captionAuto,captionEnabled,placementMode:c.placementMode==='free'?'free':'grid'}
}
module.exports={validateScene};
