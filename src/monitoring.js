/* Shared by the browser and Node tests. No network or DOM dependencies. */
(function(root) {
  'use strict';
  const labels = {online:'Поток идёт', reachable:'Адрес доступен · видео нет', offline:'Нет связи', checking:'Проверка…', connecting:'Подключение…', disabled:'Выключен'};
  const colors = {online:'#3fd39a', reachable:'#e3b35f', offline:'#ef6464', checking:'#748795', connecting:'#748795', disabled:'#748795'};
  const severity = {online:0, disabled:1, checking:1, connecting:1, reachable:2, offline:3};
  function timeline(points, end=Date.now()) {
    const start=end-86400000, count=288, interval=300000;
    const samples=points.filter(p=>Number.isFinite(p.checkedAt) && p.checkedAt>=start && p.checkedAt<=end).sort((a,b)=>a.checkedAt-b.checkedAt);
    const bins=Array.from({length:count},(_,i)=>({start:start+i*interval,status:null,reason:'',count:0}));
    for(const point of samples) {
      const bin=bins[Math.min(count-1,Math.floor((point.checkedAt-start)/interval))];
      bin.count++;
      if(bin.status===null || (severity[point.status] ?? 3)>(severity[bin.status] ?? 3)) {bin.status=point.status;bin.reason=point.reason || '';}
    }
    const outages=[];let outage=null, previous=null;
    for(const point of samples) {
      // Do not bridge a period where polling itself was absent.
      if(previous && point.checkedAt-previous.checkedAt>60000 && outage) {outage.end=previous.checkedAt;outage.unknownEnd=true;outage=null;}
      if(point.status==='offline' || point.status==='reachable') {
        if(!outage) {outage={start:point.checkedAt,end:null,reason:point.reason || labels[point.status] || 'Нет видео'};outages.push(outage);}
      } else if(outage) {outage.end=point.checkedAt;outage=null;}
      previous=point;
    }
    return {start,end,bins,outages};
  }
  const api={labels,colors,timeline};
  if(typeof module!=='undefined' && module.exports)module.exports=api;
  else root.StreamhubMonitoring=api;
})(typeof globalThis!=='undefined'?globalThis:this);
