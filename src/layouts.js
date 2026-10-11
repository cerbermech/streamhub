(function(root){
'use strict';
const sizes=[1,4,6,8,9,16,20,25,36,49,64];
function layout(size){
 if(!sizes.includes(size))throw Error('Unknown layout');
 if(size===8){const cols=4,rows=4,span=3,cells=[{col:0,row:0,colSpan:span,rowSpan:span}];for(let row=0;row<span;row++)cells.push({col:span,row,colSpan:1,rowSpan:1});for(let col=0;col<cols;col++)cells.push({col,row:span,colSpan:1,rowSpan:1});return{cols,rows,cells}}
 const cols=size===6?3:size===20?5:Math.sqrt(size),rows=size/cols;
 return{cols,rows,cells:Array.from({length:size},(_,i)=>({col:i%cols,row:Math.floor(i/cols),colSpan:1,rowSpan:1}))};
}
function rectangles(size,width,height){const {cols,rows,cells}=layout(size),xedge=n=>Math.floor(n*width/cols/2)*2,yedge=n=>Math.floor(n*height/rows/2)*2;return cells.map(c=>({x:xedge(c.col),y:yedge(c.row),w:xedge(c.col+(c.colSpan||1))-xedge(c.col),h:yedge(c.row+(c.rowSpan||1))-yedge(c.row)}))}
function canvasRects(config,width,height){if(Array.isArray(config.geometry)&&config.geometry.length===config.size)return config.geometry.map(g=>({x:Math.round(g.x*width/100),y:Math.round(g.y*height/100),w:Math.max(2,Math.round(g.w*width/100)),h:Math.max(2,Math.round(g.h*height/100))}));return rectangles(config.size,width,height)}
const api={sizes,layout,rectangles,canvasRects,label:size=>size===6?'3 × 2':size===20?'5 × 4':size===8?'1+7':String(size)};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.WallLayouts=api;
})(typeof globalThis!=='undefined'?globalThis:this);
