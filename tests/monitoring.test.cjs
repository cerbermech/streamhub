const test=require('node:test'),assert=require('node:assert/strict');
const {timeline}=require('../src/monitoring.js');
const end=86400000;
test('short outage remains visible among successful checks, boundary and missing data are preserved',()=>{
 const result=timeline([{checkedAt:0,status:'online'},{checkedAt:15000,status:'offline'},{checkedAt:30000,status:'online'},{checkedAt:end,status:'online'},{checkedAt:-1,status:'offline'}],end);
 assert.equal(result.bins.length,288);assert.equal(result.bins[0].status,'offline');assert.equal(result.bins[1].status,null);assert.equal(result.bins[287].status,'online');assert.deepEqual(result.outages,[{start:15000,end:30000,reason:'Нет связи'}]);
});
test('does not call disabled/checking states an outage or bridge unobserved periods',()=>{
 const result=timeline([{checkedAt:0,status:'disabled'},{checkedAt:15000,status:'checking'},{checkedAt:30000,status:'reachable'},{checkedAt:45000,status:'offline'},{checkedAt:200000,status:'online'}],end);
 assert.equal(result.outages.length,1);assert.equal(result.outages[0].start,30000);assert.equal(result.outages[0].end,45000);assert.equal(result.outages[0].unknownEnd,true);
});
