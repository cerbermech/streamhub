(function(root){
'use strict';
const layouts=typeof module!=='undefined'&&module.exports?require('./layouts.js'):root.WallLayouts;
function grid(n){if(layouts?.sizes.includes(n)){const g=layouts.layout(n);return g.cells.map(c=>({x:c.col/g.cols*100,y:c.row/g.rows*100,w:(c.colSpan||1)/g.cols*100,h:(c.rowSpan||1)/g.rows*100}));}const cols=Math.ceil(Math.sqrt(n)),rows=Math.ceil(n/cols);return Array.from({length:n},(_,i)=>({x:i%cols*100/cols,y:Math.floor(i/cols)*100/rows,w:100/cols,h:100/rows}));}
function normalize(c,sources=[]){
 const expected=grid(c.size);
 if(!c.placementMode)c.placementMode=Array.isArray(c.geometry)&&c.geometry.some((g,i)=>['x','y','w','h'].some(k=>Math.abs(g[k]-(expected[i]?.[k]||0))>.05))?'free':'grid';
 const names=new Map(sources.map(s=>[s.id,s.name]));
 c.geometry=Array.isArray(c.geometry)&&c.geometry.length===c.size?c.geometry:grid(c.size);
 c.captions=Array.from({length:c.size},(_,i)=>c.captions?.[i]||'');
 c.captionAuto=Array.from({length:c.size},(_,i)=>typeof c.captionAuto?.[i]==='boolean'?c.captionAuto[i]:!c.captions[i]);
 c.captionEnabled=Array.from({length:c.size},(_,i)=>c.captionEnabled?.[i]!==false);
 c.captionStyles=Array.from({length:c.size},(_,i)=>({position:'bottom-left',size:'medium',background:true,...c.captionStyles?.[i]}));
 c.fits=Array.from({length:c.size},(_,i)=>c.fits?.[i]||'cover');
 c.graphics||={title:'',clock:false,logoId:null,x:2,y:2,width:18,height:18};
 c.placementMode=c.placementMode==='free'?'free':'grid';
 c.captions=c.captions.map((text,i)=>c.captionAuto[i]?(names.get(c.slots[i])||'').slice(0,80):text);
 return c;
}
function caption(c,i,sources=[]){if(c.captionEnabled?.[i]===false)return '';return c.captionAuto?.[i]!==false?(sources.find(s=>s.id===c.slots[i])?.name||c.captions?.[i]||'').slice(0,80):c.captions?.[i]||'';}
function move(g,dx,dy,corner){
 const r={...g},snap=v=>Math.round(v*2)/2;
 if(!corner){r.x=Math.max(0,Math.min(100-g.w,snap(g.x+dx)));r.y=Math.max(0,Math.min(100-g.h,snap(g.y+dy)));}
 else{
 const left=corner.includes('w')?Math.max(0,Math.min(g.x+g.w-5,snap(g.x+dx))):g.x;
 const top=corner.includes('n')?Math.max(0,Math.min(g.y+g.h-5,snap(g.y+dy))):g.y;
 const right=corner.includes('e')?Math.min(100,Math.max(g.x+5,snap(g.x+g.w+dx))):g.x+g.w;
 const bottom=corner.includes('s')?Math.min(100,Math.max(g.y+5,snap(g.y+g.h+dy))):g.y+g.h;
 Object.assign(r,{x:left,y:top,w:right-left,h:bottom-top});
 }
 return r;
}
const api={grid,normalize,caption,move};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.StudioModel=api;
})(typeof globalThis!=='undefined'?globalThis:this);
