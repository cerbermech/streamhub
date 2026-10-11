"use strict";

const DAYS = new Set([0, 1, 2, 3, 4, 5, 6]);

function validateAutomation(value = {}) {
  const schedule = value.schedule || {};
  const windows = Array.isArray(schedule.windows) ? schedule.windows : [];
  if (windows.length > 32) throw Error("Не больше 32 интервалов расписания");
  for (const item of windows) {
    if (!Array.isArray(item.days) || item.days.some((d) => !DAYS.has(d)) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.from) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.to))
      throw Error("Неверное расписание");
  }
  return {
    autoStart: value.autoStart !== false,
    schedule: { enabled: !!schedule.enabled, windows },
    placeholder: {
      text: String(value.placeholder?.text || "НЕТ СИГНАЛА").slice(0, 80),
      color: /^#[0-9a-f]{6}$/i.test(value.placeholder?.color || "") ? value.placeholder.color : "#161f26",
    },
  };
}

function scheduleShouldRun(automation, date = new Date()) {
  const s = automation?.schedule;
  if (!s?.enabled) return !!automation?.autoStart;
  const day = date.getDay(), minute = date.getHours() * 60 + date.getMinutes();
  return s.windows.some((w) => {
    const [fh, fm] = w.from.split(":").map(Number), [th, tm] = w.to.split(":").map(Number);
    const from = fh * 60 + fm, to = th * 60 + tm;
    if (from <= to) return w.days.includes(day) && minute >= from && minute < to;
    return (w.days.includes(day) && minute >= from) || (w.days.includes((day + 6) % 7) && minute < to);
  });
}
function nextBoundary(automation,date=new Date()){const initial=scheduleShouldRun(automation,date);for(let i=1;i<=8*24*60;i++){const d=new Date(date.getTime()+i*60000);if(scheduleShouldRun(automation,d)!==initial)return d.getTime()}return date.getTime()+86400000}

module.exports = { validateAutomation, scheduleShouldRun, nextBoundary };
