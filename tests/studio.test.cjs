const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../src/studio-model.js'),{canvasRects}=require('../src/layouts.js'),{validateScene}=require('../src/scene.cjs');
test('drag uses percentage delta, clamps edges and resize preserves opposite corner',()=>{
 assert.deepEqual(M.move({x:25,y:25,w:25,h:25},5,10),{x:30,y:35,w:25,h:25});
 assert.deepEqual(M.move({x:25,y:25,w:25,h:25},200,-200),{x:75,y:0,w:25,h:25});
 assert.deepEqual(M.move({x:25,y:25,w:25,h:25},5,10,'nw'),{x:30,y:35,w:20,h:15});
});
test('default source captions follow replacements, manual and hidden captions remain deliberate',()=>{
 const sources=[{id:'a',name:'Вход'},{id:'b',name:'Парковка'}],c=M.normalize({size:1,slots:['a'],captions:['']},sources);
 assert.equal(M.caption(c,0,sources),'Вход');c.slots[0]='b';assert.equal(M.caption(c,0,sources),'Парковка');
 c.captionAuto[0]=false;c.captions[0]='Своя подпись';assert.equal(M.caption(c,0,sources),'Своя подпись');c.captionEnabled[0]=false;assert.equal(M.caption(c,0,sources),'');
 const saved=validateScene(c);assert.equal(saved.captionAuto[0],false);assert.equal(saved.captionEnabled[0],false);
});
test('custom geometry always encodes within bounds with even chroma dimensions',()=>{
 const rect=canvasRects({size:1,geometry:[{x:33.3,y:12.1,w:66.7,h:50.3}]},640,360)[0];for(const n of Object.values(rect))assert.equal(n%2,0);assert(rect.x+rect.w<=640);assert(rect.y+rect.h<=360);
});

test('studio preserves the special 1+7 standard wall layout',()=>{const g=M.grid(8);assert.equal(g[0].w,75);assert.equal(g[0].h,75);assert.equal(g[7].y,75);});
