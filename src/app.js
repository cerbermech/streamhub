"use strict";
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let model = { sources: [], channels: [], layouts: [] },
  view = new URLSearchParams(location.search).get("view") || "wall",
  size = 9,
  slots = [],
  fits = [],
  savedLayout = null,
  selected = 0,
  expanded = null,
  ptzOpen = false,
  editing = null,
  players = [],
  activePreview = new Set(),
  session = false,
  dragging = false,
  sourcePageQuery = "",
  renderedView = null,
  scrollPositions = JSON.parse(sessionStorage.getItem("streamhub-scroll") || "{}"),
  desktopBootstrap = new URLSearchParams(location.hash.slice(1)).get("bootstrap") || null;
const statusName = {
  idle: "Не используется",
  online: "Сигнал есть",
  connecting: "Подключение",
  offline: "Нет сигнала",
  live: "В эфире",
  encoding: "Ожидание публикации",
  starting: "Запускается",
  error: "Перезапуск",
  stopped: "Остановлен",
  disabled: "Выключен",
};
const navIcon = (body) =>
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  body +
  "</svg>";
const navIcons = {
  wall: navIcon(
    '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
  ),
  channels: navIcon(
    '<path d="M5 8.5a9 9 0 0 0 0 7M8 11a4 4 0 0 0 0 2"/><circle cx="12" cy="12" r="2"/><path d="M16 11a4 4 0 0 1 0 2M19 8.5a9 9 0 0 1 0 7"/>',
  ),
  sources: navIcon(
    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m8 14 3-3 5 5 2-2 3 3"/><circle cx="8" cy="9" r="1"/>',
  ),
  diagnostics: navIcon('<path d="M4 15h3l2-7 4 11 3-8 2 4h2"/>'),
  monitoring: navIcon('<path d="M3 12h3l2-5 4 10 3-7 2 3h4"/><circle cx="19" cy="5" r="2"/>'),
  users: navIcon(
    '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-4 2.5-6 5.5-6s5 2 5.5 6M16 6.5a3 3 0 0 1 0 5.5M16 14c2.5.5 4 2 4.5 5"/>',
  ),
  archive: navIcon('<path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/>'),
  automation: navIcon('<circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/>'),
  events: navIcon(
    '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  ),
  settings: navIcon(
    '<circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L10.5 2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7z" transform="translate(2.2 0) scale(.82)"/>',
  ),
};
const actionIcons = {
  save: navIcon('<path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 21v-7h8v7"/>'),
  manage: navIcon('<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/>'),
  expand: navIcon('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>'),
  panels: navIcon('<path d="M4 5h16v14H4zM9 5v14M9 10h11"/>'),
  fullscreen: navIcon('<path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/>'),
  ptz: navIcon('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M21 12l-3-3M21 12l-3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3"/>'),
};
async function api(url, method = "GET", data) {
  const r = await fetch("/api" + url, {
    method,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const j = await r.json();
  if (!r.ok) {
    if (r.status === 401) session = false;
    throw Error(j.error || "Ошибка сервера");
  }
  return j;
}
function toast(t) {
  $("#toast").textContent = t;
  $("#toast").style.display = "block";
  clearTimeout(window.tt);
  window.tt = setTimeout(() => ($("#toast").style.display = "none"), 4500);
}
function modal(title, fields, submit, label = "Сохранить") {
  const d = $("#dialog");
  d.oncancel = null;
  d.className = "";
  d.innerHTML =
    "<form><h2>" +
    title +
    "</h2>" +
    fields +
    '<p class="help" id="formError" role="alert"></p><div class="tools"><button type="button" id="cancel">Отмена</button><button class="primary" id="submit">' +
    label +
    "</button></div></form>";
  $("#cancel").onclick = () => d.close();
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    $("#submit").disabled = true;
    try {
      await submit(new FormData(e.target));
      d.close();
    } catch (err) {
      $("#formError").textContent = err.message;
      $("#submit").disabled = false;
    }
  };
  d.showModal();
}
function login() {
  dispose();
  $("#dialog").close();
  modal(
    "Вход в STREAMHUB",
    '<label>Логин<input name="user" required autocomplete="username" value="admin"></label><label>Пароль<input type="password" name="password" required autocomplete="current-password"></label><p class="help">Первый пароль администратора находится в файле first-login.txt.</p>',
    async (f) => {
      await api("/login", "POST", Object.fromEntries(f));
      session = true;
      await refresh();
      render();
    },
    "Войти",
  );
  $("#cancel").hidden = true;
  $("#dialog").oncancel = (e) => e.preventDefault();
}
async function refresh() {
  model = await api("/state");
  session = true;
  document.querySelector("header .badge").textContent = model.mediaReady
    ? "Видеосервер подключён"
    : "Видеосервер недоступен";
  document.querySelector("header .badge").dataset.tone = model.mediaReady
    ? "success"
    : "danger";
  document.querySelector(".footer span").textContent = model.mediaReady
    ? "● Сервер подключён"
    : "◌ Сервер недоступен";
  $("#foot").textContent =
    model.channels.filter((c) => c.status === "live").length +
    " каналов в эфире · " +
    model.sources.length +
    " источников";
  sourceList();
  document.querySelectorAll('.source-status[data-source-id]').forEach(el=>{
    const item=model.sources.find(s=>s.id===el.dataset.sourceId);
    if(item){el.dataset.sourceState=item.status;el.textContent=statusName[item.status] || item.status;}
  });
  document.querySelectorAll(".tile-state").forEach(el => {
    const tile=el.closest('[data-tile]'), item=model.sources.find(s=>s.id===slots[+tile.dataset.tile]);
    el.dataset.state=item?.status || 'empty'; el.setAttribute('aria-label',statusName[item?.status] || 'Пустая ячейка');
  });
  document.querySelectorAll('.channel-state').forEach(el=>{
    const item=model.channels.find(c=>c.id===el.closest('[data-channel-order]')?.dataset.channelOrder);
    if(item)el.dataset.channelState=item.status;
  });
  document.querySelectorAll("[data-viewers]").forEach((el) => {
    const channel = model.channels.find((item) => item.id === el.dataset.viewers);
    if (channel) el.textContent = channel.viewers == null ? "—" : channel.viewers;
  });
  document.querySelectorAll("[data-action]").forEach((b) => {
    const c = model.channels.find((c) => c.id === b.dataset.id);
    if (c) {
      b.dataset.action = c.desired ? "stop" : "start";
      b.textContent = c.desired ? "Остановить" : "Запустить";
    }
  });
  document.querySelectorAll("[data-encoder]").forEach((b) => {
    const c = model.channels.find((c) => c.id === b.dataset.encoder);
    if (c) b.textContent = c.effectiveEncoder;
  });
  document.querySelectorAll("[data-status]").forEach((el) => {
    const c = model.channels.find((c) => c.id === el.dataset.status);
    if (c) {
      el.textContent = statusName[c.status] || c.status;
      el.dataset.tone =
        c.status === "live"
          ? "success"
          : c.status === "error"
            ? "danger"
            : "warning";
    }
  });
  document.querySelectorAll("[data-error]").forEach((el) => {
    const c = model.channels.find((c) => c.id === el.dataset.error);
    if (c) el.textContent = c.reason || c.fallback || c.error || "";
  });
}
async function waitForServerRestart() {
  let wentOffline = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (!response.ok) throw Error("offline");
      if (!wentOffline) continue;
      if (!desktopBootstrap) {
        location.reload();
        return true;
      }
      await api("/login", "POST", { user: "admin", bootstrap: desktopBootstrap });
      await refresh();
      render();
      return true;
    } catch {
      wentOffline = true;
    }
  }
  return false;
}
function dispose() {
  players.forEach((p) => p.destroy());
  players = [];
  activePreview.clear();
}
function play(video, url) {
  if (window.Hls?.isSupported()) {
    const h = new Hls({
      maxBufferLength: 8,
      backBufferLength: 0,
      manifestLoadingMaxRetry: 15,
      manifestLoadingRetryDelay: 1500,
    });
    h.loadSource(url);
    h.attachMedia(video);
    players.push(h);
    h.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    h.on(Hls.Events.ERROR, (_, d) => {
      if (d.fatal) {
        const el = video.parentElement.querySelector(".play-status");
        if (el) el.textContent = "Поток недоступен. Ожидание восстановления";
        clearTimeout(video._reconnectTimer);
        video._reconnectTimer = setTimeout(() => {
          if (!video.isConnected) return;
          try { h.destroy(); } catch {}
          video.removeAttribute("src");
          play(video, url);
        }, 3000);
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.play().catch(() => {});
    video.onerror = () => {
      clearTimeout(video._reconnectTimer);
      video._reconnectTimer = setTimeout(() => {
        if (!video.isConnected) return;
        video.load();
        video.play().catch(() => {});
      }, 3000);
    };
  } else toast("Браузер не поддерживает HLS");
  video.onplaying = () => {
    clearTimeout(video._reconnectTimer);
    const el = video.parentElement.querySelector(".play-status");
    if (el) el.style.display = "none";
  };
}
function sourceList() {
  if (dragging) return;
  const q = $("#search").value.toLowerCase();
  $("#count").textContent = model.sources.length;
  $("#sourceList").innerHTML =
    "<h4>Подключённые источники</h4>" +
    model.sources
      .filter((s) => [s.name,s.description].filter(Boolean).some((v)=>v.toLowerCase().includes(q)))
      .map(
        (s) =>
          '<button class="source" draggable="true" data-source="' +
          s.id +
          '" title="' +
          esc(statusName[s.status]) +
          '"><span class="dot" style="background:' +
          (s.status === "online" ? "#65d7b4" : "#73828e") +
          '"></span>' +
          esc(s.name) +
          "</button>",
      )
      .join("");
  document.querySelectorAll("[data-source]").forEach((b) => {
    b.ondragstart = (e) => {
      dragging = true;
      e.dataTransfer.setData(
        "application/x-videowall",
        JSON.stringify({ source: b.dataset.source }),
      );
      e.dataTransfer.effectAllowed = "copy";
    };
    b.onclick = () => {
      slots[selected] = b.dataset.source;
      if (view !== "wall") view = "wall";
      render();
    };
  });
  $("#addSource").hidden = model.role !== "admin";
}
async function addSource(existing) {
  const capture=existing?.capture||null, currentType=capture?.kind||"network";
  let inventory={displays:[],devices:[]};
  try{inventory=await api("/capture/inventory")}catch{}
  const displayOptions=inventory.displays.map(x=>`<option value="${esc(x.id)}" data-x="${x.x}" data-y="${x.y}" data-width="${x.width}" data-height="${x.height}" ${capture?.kind==="screen"&&capture.target===x.id?"selected":""}>${esc(x.name)}${x.primary?" · основной":""}</option>`).join("");
  const windowOptions=(inventory.windows||[]).map(x=>`<option value="${esc(x.id)}" ${capture?.kind==="window"&&capture.target===x.id?"selected":""}>${esc(x.name)}</option>`).join("");
  const deviceOptions=inventory.devices.map(x=>`<option value="${esc(x.id)}" ${capture?.kind==="device"&&capture.target===x.id?"selected":""}>${esc(x.name)}</option>`).join("");
  modal(
    existing ? "Изменить источник" : "Добавить источник",
    '<label>Название<input name="name" required maxlength="80" value="' +
      esc(existing?.name || "") +
      '"></label><label>Тип источника<select name="type" id="sourceType"><option value="network" '+(currentType==="network"?"selected":"")+'>HTTP / RTSP</option><option value="screen" '+(currentType==="screen"?"selected":"")+'>Экран или область монитора</option><option value="window" '+(currentType==="window"?"selected":"")+'>Окно приложения</option><option value="device" '+(currentType==="device"?"selected":"")+'>USB / HDMI-видеоустройство</option></select></label><div data-source-kind="network"><label>URL<input name="url" ' +
      (existing ? "" : "required") +
      ' type="url" placeholder="rtsp://192.168.1.10/stream" value="' +
      esc(existing?.url || "") +
      '"></label><label>Транспорт RTSP<select name="transport"><option value="tcp" '+(existing?.transport!=="udp"?"selected":"")+'>TCP — надёжнее</option><option value="udp" '+(existing?.transport==="udp"?"selected":"")+'>UDP — меньше задержка</option></select></label><label>Логин камеры<input name="username" autocomplete="off" value="' +
      esc(existing?.username || "") +
      '"></label><label>Пароль камеры<input name="password" type="password" autocomplete="new-password" placeholder="' +
      (existing ? "Оставьте пустым, чтобы не менять" : "") +
      '"></label></div><div data-source-kind="screen"><label>Монитор<select name="targetScreen" id="captureDisplay">'+displayOptions+'</select></label><div class="row"><label>Смещение X<input name="screenX" type="number" value="'+esc(capture?.x??0)+'"></label><label>Смещение Y<input name="screenY" type="number" value="'+esc(capture?.y??0)+'"></label></div><label class="check"><input name="cursor" type="checkbox" '+(capture?.cursor===false?"":"checked")+'> Показывать курсор</label><p class="help">Для области экрана задайте X, Y, ширину и высоту. Захват работает, пока панель Видеостены запущена в трее.</p></div><div data-source-kind="window"><label>Окно<select name="targetWindow">'+windowOptions+'</select></label><label class="check"><input name="windowCursor" type="checkbox" '+(capture?.cursor===false?"":"checked")+'> Показывать курсор</label><p class="help">Окно должно оставаться открытым. После перезапуска приложения оно будет найдено по заголовку.</p></div><div data-source-kind="device"><label>Видеоустройство<select name="targetDevice">'+deviceOptions+'</select></label><label>Формат<select name="format"><option value="auto">Автоматически</option><option value="mjpeg" '+(capture?.format==="mjpeg"?"selected":"")+'>MJPEG</option><option value="yuyv422" '+(capture?.format==="yuyv422"?"selected":"")+'>YUY2</option><option value="nv12" '+(capture?.format==="nv12"?"selected":"")+'>NV12</option></select></label><p class="help">HDMI подключается через USB/PCIe-карту захвата. Если автоматический формат не запускается, попробуйте MJPEG.</p></div><div data-source-kind="capture"><div class="row"><label>Ширина<input name="width" type="number" min="160" max="7680" value="'+esc(capture?.width||1280)+'"></label><label>Высота<input name="height" type="number" min="120" max="4320" value="'+esc(capture?.height||720)+'"></label></div><label>Кадров в секунду<select name="fps">'+[10,15,25,30,50,60].map(x=>`<option ${x===(capture?.fps||25)?"selected":""}>${x}</option>`).join("")+'</select></label></div><label>Качество обработки<select name="quality">' +
      ["360p", "720p", "1080p"]
        .map(
          (q) =>
            "<option " +
            (q === (existing?.quality || "720p") ? "selected" : "") +
            ">" +
            q +
            "</option>",
        )
        .join("") +
      '</select></label><label class="source-description-field">Описание<textarea name="description" maxlength="500" rows="4" placeholder="Корпус, этаж, назначение или примечание">'+esc(existing?.description||"")+'</textarea></label><p class="help">Название и описание участвуют в поиске. Источник можно использовать в видеостене, студии, архиве и выходных HTTP/RTSP-каналах.</p>',
    async (f) => {
      const data=Object.fromEntries(f), type=data.type;
      if(type==="screen"){data.target=data.targetScreen;data.x=+data.screenX;data.y=+data.screenY;data.cursor=$("#dialog [name=cursor]").checked}
      if(type==="window"){data.target=data.targetWindow;data.cursor=$("#dialog [name=windowCursor]").checked}
      if(type==="device")data.target=data.targetDevice;
      const result = await api(
        existing ? "/sources/" + existing.id : "/sources",
        existing ? "PUT" : "POST",
        data,
      );
      await refresh();
      slots[selected] = existing?.id || result.id;
      render();
    },
  );
  const type=$("#sourceType"), refreshKinds=()=>{const value=type.value;document.querySelectorAll("[data-source-kind]").forEach(x=>x.hidden=x.dataset.sourceKind!==value&&!(x.dataset.sourceKind==="capture"&&(value==="screen"||value==="window"||value==="device")));const url=$("#dialog [name=url]");if(url)url.required=value==="network"};
  type.onchange=refreshKinds;refreshKinds();
  const display=$("#captureDisplay");if(display)display.onchange=()=>{const o=display.selectedOptions[0];if(!o)return;for(const [name,key] of [["screenX","x"],["screenY","y"],["width","width"],["height","height"]])$("#dialog [name="+name+"]").value=o.dataset[key]};
}
function configureOnvif(source, device = {}) {
  let host = device.host || "";
  if (!host && source?.url) {
    try { host = new URL(source.url).hostname; } catch {}
  }
  modal(
    "Подключение ONVIF" + (source ? " · " + source.name : ""),
    '<label>IP-адрес или имя камеры<input name="host" required value="' +
      esc(host) +
      '"></label><label>Порт ONVIF<input name="port" type="number" min="1" max="65535" value="' +
      esc(device.port || 80) +
      '"></label><label>Путь службы<input name="path" value="' +
      esc(device.path || "/onvif/device_service") +
      '"></label><label>Логин<input name="username" autocomplete="off" value="' +
      esc(source?.username || "") +
      '"></label><label>Пароль<input name="password" type="password" autocomplete="new-password"></label><p class="help">Используются учётные данные самой камеры. Проверка подключения выполняется перед сохранением.</p>',
    async (form) => {
      const data = Object.fromEntries(form);
      if (source) await api("/sources/" + source.id + "/onvif", "PUT", data);
      else {
        data.name = device.name || "ONVIF · " + data.host;
        await api("/onvif/add", "POST", data);
      }
      await refresh();
      render();
      toast(source ? "ONVIF подключён" : "Камера добавлена");
    },
    source ? "Подключить" : "Добавить камеру",
  );
}
async function discoverOnvif() {
  toast("Ищем ONVIF-камеры в локальной сети…");
  try {
    const result = await api("/onvif/discover");
    modal(
      "Найденные ONVIF-камеры",
      result.devices.length
        ? '<div class="onvif-devices">' + result.devices.map((d, i) =>
            '<div class="onvif-device"><div><b>' + esc(d.host) +
            '</b><span>Порт ' + d.port + ' · ' + esc(d.path) +
            '</span></div><button type="button" data-onvif-device="' + i + '">Добавить</button></div>')
            .join("") + "</div>"
        : '<div class="empty-state compact"><b>Камеры не найдены</b><span>Проверьте, что ONVIF включён в настройках камеры и компьютер находится в той же сети.</span></div>',
      () => {},
      "Закрыть",
    );
    $("#cancel").hidden = true;
    document.querySelectorAll("[data-onvif-device]").forEach((button) => {
      button.onclick = () => {
        $("#dialog").close();
        configureOnvif(null, result.devices[Number(button.dataset.onvifDevice)]);
      };
    });
  } catch (error) {
    toast("Поиск ONVIF не выполнен: " + error.message);
  }
}
async function openPtz(source, compact = false) {
  toast("Подключаемся к камере…");
  try {
    const info = await api("/sources/" + source.id + "/onvif");
    const presetOptions = info.presets.map((p) =>
      '<option value="' + esc(p.token) + '">' + esc(p.name) + "</option>").join("");
    modal(
      "Управление камерой · " + source.name,
      '<div class="camera-info"><b>' + esc([info.manufacturer, info.model].filter(Boolean).join(" ") || source.name) +
      '</b><span>' + esc(info.firmware ? "Прошивка " + info.firmware : "ONVIF подключён") +
      '</span></div>' +
      (info.ptz
        ? '<label>Скорость<input id="ptzSpeed" type="range" min="0.1" max="1" step="0.1" value="0.5"></label><div class="ptz-pad"><button type="button" data-ptz="0,1,0">▲</button><button type="button" data-ptz="-1,0,0">◀</button><button type="button" data-ptz-stop>■</button><button type="button" data-ptz="1,0,0">▶</button><button type="button" data-ptz="0,-1,0">▼</button></div><div class="tools ptz-zoom"><button type="button" data-ptz="0,0,1">＋ Приблизить</button><button type="button" data-ptz="0,0,-1">− Отдалить</button><button type="button" data-onvif-action="home">Домой</button></div><div class="preset-row"><select id="ptzPreset"><option value="">Выберите пресет</option>' + presetOptions + '</select><button type="button" data-onvif-action="preset">Перейти</button><button type="button" data-onvif-action="savePreset">Сохранить позицию</button><button type="button" data-onvif-action="removePreset">Удалить</button></div>'
        : '<p class="inline-message">Камера отвечает по ONVIF, но PTZ-профиль не обнаружен.</p>') +
      (compact ? '' : '<div class="section-heading"><div><h3>Обслуживание</h3><p>Системные команды камеры</p></div></div><div class="tools"><button type="button" data-onvif-action="syncTime">Синхронизировать время</button><button type="button" class="danger-quiet" data-onvif-action="reboot">Перезагрузить камеру</button></div>') + '<p id="ptzStatus" class="help"></p>',
      () => {},
      "Закрыть",
    );
    $("#cancel").hidden = true;
    const send = async (data) => {
      const status = $("#ptzStatus");
      try {
        await api("/sources/" + source.id + "/onvif/command", "POST", data);
        status.textContent = "Команда выполнена";
      } catch (error) { status.textContent = error.message; }
    };
    document.querySelectorAll("[data-ptz]").forEach((button) => {
      let startedAt = 0;
      const start = (event) => {
        event.preventDefault();
        startedAt = performance.now();
        button.setPointerCapture?.(event.pointerId);
      };
      button.onpointerdown = start;
      button.onpointerup = () => {
        const [x, y, zoom] = button.dataset.ptz.split(",").map(Number);
        const duration = Math.max(220, Math.min(1800, Math.round(performance.now() - startedAt)));
        send({ action: "pulse", x, y, zoom, duration, speed: Number($("#ptzSpeed")?.value || 0.5) });
      };
      button.onpointercancel = () => send({ action: "stop" });
    });
    document.querySelector("[data-ptz-stop]")?.addEventListener("click", () => send({ action: "stop" }));
    document.querySelectorAll("[data-onvif-action]").forEach((button) => {
      button.onclick = async () => {
        const action = button.dataset.onvifAction, token = $("#ptzPreset")?.value || "";
        if (action === "savePreset") {
          const name = prompt("Название новой позиции");
          if (name) await send({ action, name });
        } else if (action === "reboot") {
          if (confirm("Перезагрузить камеру? Поток временно пропадёт.")) await send({ action });
        } else await send({ action, token });
      };
    });
  } catch (error) {
    toast(error.message);
  }
}
function channelForm(existing) {
  modal(
    existing ? "Параметры канала" : "Создать канал",
    '<label>Название<input name="name" required maxlength="80" value="' +
      esc(existing?.name || "") +
      '"></label><label>Короткий адрес<input name="slug" required pattern="[a-z0-9][a-z0-9-]{0,47}" maxlength="48" ' +
      (existing ? "readonly" : "") +
      ' value="' +
      esc(existing?.slug || model.nextSlug) +
      '"></label><p class="help">Например, kanal-1 или parking. Адрес сохраняется при переименовании канала.</p><label>Качество<select name="quality">' +
      ["360p", "720p", "1080p"]
        .map(
          (x) =>
            "<option " +
            (x === (existing?.quality || "720p") ? "selected" : "") +
            ">" +
            x +
            "</option>",
        )
        .join("") +
      '</select></label><label>Кадров в секунду<select name="fps">' +
      [10, 15, 25]
        .map(
          (x) =>
            "<option " +
            (x === (existing?.fps || 25) ? "selected" : "") +
            ">" +
            x +
            "</option>",
        )
        .join("") +
      '</select></label><label>Звук<select name="audioSource"><option value="">Без звука</option>' +
      model.sources
        .map(
          (a) =>
            '<option value="' +
            a.id +
            '" ' +
            (a.id === existing?.audioSource ? "selected" : "") +
            ">" +
            esc(a.name) +
            "</option>",
        )
        .join("") +
      '</select></label><label>Кодировщик<select name="encoder">' +
      [
        ["libx264", "CPU · H.264"],
        ["h264_nvenc", "NVIDIA NVENC"],
        ["h264_qsv", "Intel Quick Sync"],
      ]
        .filter(([id]) => model.encoders.includes(id))
        .map(
          ([id, label]) =>
            '<option value="' +
            id +
            '" ' +
            (id === (existing?.encoder || "libx264") ? "selected" : "") +
            ">" +
            label +
            "</option>",
        )
        .join("") +
      '</select></label><label>Битрейт, кбит/с<input name="bitrate" type="number" min="200" max="20000" value="' +
      (existing?.bitrate || 2000) +
      '" required></label><p class="help">Используется текущая раскладка (' +
      size +
      " ячеек). Если аппаратный кодировщик не запускается, канал автоматически переходит на CPU. Применение изменений перезапускает работающий канал.</p>",
    async (f) => {
      const c = {
        slug: f.get("slug"),
        fits: Array.from({ length: size }, (_, i) => fits[i] || "cover"),
        audioSource: f.get("audioSource") || null,
        encoder: f.get("encoder"),
        name: f.get("name"),
        quality: f.get("quality"),
        fps: +f.get("fps"),
        bitrate: +f.get("bitrate"),
        size,
        slots: Array.from({ length: size }, (_, i) => slots[i] || null),
      };
      await api(
        existing ? "/channels/" + existing.id : "/channels",
        existing ? "PUT" : "POST",
        c,
      );
      editing = null;
      view = "channels";
      await refresh();
      render();
    },
  );
}
function render() {
  const previousContent=document.querySelector("#main > .content");
  if(previousContent&&renderedView){scrollPositions[renderedView]=previousContent.scrollTop;sessionStorage.setItem("streamhub-scroll",JSON.stringify(scrollPositions))}
  const owner = model.role === "admin",
    admin = owner || model.role === "operator";
  selected = Math.max(0, Math.min(selected, size - 1));
  if (expanded !== null && expanded >= size) expanded = null;
  dispose();
  $("#nav").innerHTML = [
    ["wall", navIcons.wall, "Просмотр"],
    ["channels", navIcons.channels, "Каналы"],
    ["sources", navIcons.sources, "Источники"],
    ["monitoring", navIcons.monitoring, "Мониторинг"],
    ...(owner ? [["diagnostics", navIcons.diagnostics, "Диагностика"]] : []),
    ...(owner ? [["users", navIcons.users, "Пользователи"]] : []),
    ...(owner ? [["archive", navIcons.archive, "Архив"]] : []),
    ...(admin
      ? [
          ["automation", navIcons.automation, "Автоматизация"],
          ["events", navIcons.events, "События"],
        ]
      : []),
    ["settings", navIcons.settings, "Настройки"],
  ]
    .map(
      ([id, icon, label]) =>
        '<button class="' +
        (view === id ? "active" : "") +
        '" data-view="' +
        id +
        '"><span class="nav-icon">' +
        icon +
        '</span><span class="nav-label">' +
        label +
        "</span></button>",
    )
    .join("");
  document.querySelectorAll("[data-view]").forEach(
    (b) =>
      (b.onclick = () => {
        view = b.dataset.view;
        expanded = null;
        render();
      }),
  );
  sourceList();
  const tb = $("#toolbar");
  if (view === "wall") {
    tb.innerHTML =
      '<div class="tools wall-layout-tools"><label class="compact-field"><span>Сетка</span><select id="wallSize" aria-label="Размер сетки">' +
      WallLayouts.sizes.map((n) => '<option value="'+n+'" '+(size === n ? 'selected' : '')+'>'+esc(WallLayouts.label(n))+'</option>').join("") +
      '</select></label>' +
      '<select id="saved" aria-label="Сохранённый вид"><option value="">Сохранённые виды</option>' +
      model.layouts
        .map(
          (l, i) =>
            '<option value="' +
            i +
            '" ' +
            (l.id === savedLayout ? "selected" : "") +
            ">" +
            esc(l.name) +
            "</option>",
        )
        .join("") +
      '</select></div><div class="tools">' +
      (admin
        ? '<button class="icon-action" id="saveLayout" aria-label="Сохранить вид" title="Сохранить вид">'+actionIcons.save+'</button><button class="icon-action" id="manageLayout" aria-label="Управление видом" title="Управление видом" ' +
          (!savedLayout ? "disabled" : "") +
          '>'+actionIcons.manage+'</button><button class="primary compact-primary" id="saveChannel">' +
          (editing ? "Применить" : "+ Канал") +
          "</button>"
        : "") +
      '<button class="icon-action" id="expandSelected" aria-label="Открыть выбранную камеру" title="Открыть выбранную камеру · Enter">'+actionIcons.expand+'</button><button class="icon-action" id="hidePanels" aria-label="Скрыть элементы управления" title="Скрыть элементы управления · H">'+actionIcons.panels+'</button><button class="icon-action" id="shortcuts" aria-label="Горячие клавиши" title="Горячие клавиши">?</button><button class="icon-action" id="fullscreen" aria-label="Полный экран" title="Полный экран · F">'+actionIcons.fullscreen+'</button></div>';
    const geometry = WallLayouts.layout(size);
    const indexes =
      expanded === null
        ? Array.from({ length: size }, (_, i) => i)
        : [expanded];
    $("#main").innerHTML =
      '<div class="grid '+(expanded === null && size >= 25 ? 'dense-grid' : '')+'" data-grid-size="'+size+'" style="--cols:' +
      (expanded === null ? geometry.cols : 1) +
      ";--rows:" +
      (expanded === null ? geometry.rows : 1) +
      '">' +
      indexes
        .map((i) => {
          const s = model.sources.find((s) => s.id === slots[i]);
          const cell =
            expanded === null ? geometry.cells[i] : { row: 0, col: 0, rowSpan: 1, colSpan: 1 };
          return (
            '<section style="grid-area:' +
            (cell.row + 1) +
            " / " +
            (cell.col + 1) +
            " / span " +
            (cell.rowSpan || 1) +
            " / span " +
            (cell.colSpan || 1) +
            '" draggable="true" class="tile ' +
            (i === selected ? "selected" : "") +
            '" tabindex="0" data-tile="' +
            i +
            '">' +
            (s
              ? '<video muted autoplay playsinline style="object-fit:' +
                (fits[i] || "cover") +
                '" data-fit="' +
                (fits[i] || "cover") +
                '" data-video="' +
                s.id +
                '"></video><div class="empty play-status" style="position:absolute;inset:0;pointer-events:none">Подключение к потоку…</div>'
              : '<div class="empty"><b>▧</b><span>Выберите источник слева</span></div>') +
            '<div class="tile-head"><span class="tile-state" data-state="'+esc(s?.status || 'empty')+'" aria-label="'+esc(statusName[s?.status] || 'Пустая ячейка')+'"></span><span title="'+esc(s?.name || 'Пустая ячейка')+'">' +
            esc(s?.name || "Ячейка " + (i + 1)) +
            '</span></div>' +
            (expanded === i && s?.onvif && admin
              ? '<button type="button" class="tile-ptz-toggle '+(ptzOpen?'active':'')+'" data-inline-ptz-toggle aria-expanded="'+String(ptzOpen)+'" aria-label="'+(ptzOpen?'Закрыть':'Открыть')+' PTZ" title="PTZ">'+actionIcons.ptz+'</button>'+(ptzOpen ? '<div class="inline-ptz" data-inline-ptz="'+esc(s.id)+'" aria-label="Управление PTZ"><div class="inline-ptz__title"><b>Управление камерой</b><button type="button" data-inline-ptz-close aria-label="Закрыть PTZ">×</button></div><div class="inline-ptz__body"><div class="inline-ptz__pad"><button type="button" data-inline-move="0,1,0" title="Вверх">▲</button><button type="button" data-inline-move="-1,0,0" title="Влево">◀</button><button type="button" data-inline-stop title="Стоп">■</button><button type="button" data-inline-move="1,0,0" title="Вправо">▶</button><button type="button" data-inline-move="0,-1,0" title="Вниз">▼</button></div><div class="inline-ptz__side"><span>СКОРОСТЬ</span><input data-inline-speed type="range" min="0.1" max="1" step="0.1" value="0.5" title="Скорость"><button type="button" data-inline-move="0,0,1" title="Приблизить">＋</button><button type="button" data-inline-move="0,0,-1" title="Отдалить">−</button><button type="button" data-inline-home title="Домашняя позиция">⌂</button></div></div><span class="inline-ptz__status"></span></div>' : '')
              : '') +
            '<div class="tile-foot"><button class="fit-button" data-fit-toggle="' +
            i +
            '" title="Вписать целиком или заполнить с обрезкой">' +
            (fits[i] === "cover" ? "Заполнить" : "Вписать") +
            '</button><select aria-label="Источник ячейки ' +
            (i + 1) +
            '" data-slot="' +
            i +
            '"><option value="">Пустая ячейка</option>' +
            model.sources
              .map(
                (a) =>
                  '<option value="' +
                  a.id +
                  '" ' +
                  (a.id === s?.id ? "selected" : "") +
                  ">" +
                  esc(a.name) +
                  "</option>",
              )
              .join("") +
            "</select></div></section>"
          );
        })
        .join("") +
      "</div>";
    $("#wallSize").onchange = (event) => {
      size = Number(event.target.value);
      selected = 0;
      expanded = null;
      ptzOpen = false;
      render();
    };
    $("#saved").onchange = (e) => {
      if (e.target.value === "") return;
      const l = model.layouts[+e.target.value];
      size = l.size;
      slots = [...l.slots];
      fits = [...(l.fits || [])];
      savedLayout = l.id;
      selected = 0;
      expanded = null;
      editing = null;
      render();
    };
    if (admin) {
      $("#saveChannel").onclick = () =>
        channelForm(model.channels.find((c) => c.id === editing));
      $("#saveLayout").onclick = () =>
        modal(
          "Сохранить текущий вид",
          '<label>Название<input name="name" required maxlength="80"></label>',
          async (f) => {
            const id = crypto.randomUUID
              ? crypto.randomUUID()
              : String(Date.now()) + "-" + Math.random().toString(36).slice(2);
            await api("/layouts", "PUT", [
              ...model.layouts,
              { ...layoutSnapshot(), id, name: f.get("name") },
            ]);
            savedLayout = id;
            await refresh();
            render();
          },
        );
      $("#manageLayout").onclick = manageLayout;
    }
    $("#expandSelected").onclick = () => {
      expanded = expanded === null ? selected : null;
      ptzOpen = false;
      render();
    };
    $("#hidePanels").onclick = togglePanels;
    $("#shortcuts").onclick = showShortcuts;
    $("#fullscreen").onclick = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch {
        toast("Полный экран недоступен");
      }
    };
    document.querySelectorAll("[data-fit-toggle]").forEach((b) => {
      b.ondblclick = (e) => e.stopPropagation();
      b.onclick = (e) => {
        e.stopPropagation();
        const i = +b.dataset.fitToggle;
        fits[i] = fits[i] === "cover" ? "contain" : "cover";
        render();
      };
    });
    document.querySelectorAll("[data-slot]").forEach((s) => {
      s.onclick = (e) => e.stopPropagation();
      s.ondblclick = (e) => e.stopPropagation();
      s.onchange = () => {
        slots[+s.dataset.slot] = s.value;
        render();
      };
    });
    document.querySelector("[data-inline-ptz-toggle]")?.addEventListener("click", (event) => {
      event.stopPropagation();
      ptzOpen = !ptzOpen;
      render();
    });
    document.querySelectorAll("[data-inline-ptz]").forEach((panel) => {
      const sourceId = panel.dataset.inlinePtz;
      const status = panel.querySelector(".inline-ptz__status");
      const sendPtz = async (payload) => {
        try {
          await api("/sources/" + sourceId + "/onvif/command", "POST", payload);
          status.textContent = "";
        } catch (error) { status.textContent = error.message; }
      };
      panel.onclick = panel.ondblclick = (event) => event.stopPropagation();
      panel.querySelector("[data-inline-ptz-close]").onclick = () => { ptzOpen = false; render(); };
      panel.querySelectorAll("[data-inline-move]").forEach((button) => {
        let startedAt = 0;
        button.onpointerdown = (event) => {
          event.preventDefault();
          event.stopPropagation();
          startedAt = performance.now();
          button.setPointerCapture?.(event.pointerId);
        };
        button.onpointerup = (event) => {
          event.preventDefault();
          event.stopPropagation();
          const [x, y, zoom] = button.dataset.inlineMove.split(",").map(Number);
          const duration = Math.max(220, Math.min(1800, Math.round(performance.now() - startedAt)));
          sendPtz({ action: "pulse", x, y, zoom, duration, speed: Number(panel.querySelector("[data-inline-speed]").value) });
        };
        button.onpointercancel = () => sendPtz({ action: "stop" });
      });
      panel.querySelector("[data-inline-stop]").onclick = () => sendPtz({ action: "stop" });
      panel.querySelector("[data-inline-home]").onclick = () => sendPtz({ action: "home" });
    });
    document.querySelectorAll("[data-tile]").forEach((el) => {
      el.onclick = (event) => {
        if(event.target.closest("button,select,input"))return;
        selected = +el.dataset.tile;
        if(size>=25 && expanded===null){expanded=selected;ptzOpen=false;render();return;}
        document
          .querySelectorAll(".tile")
          .forEach((t) => t.classList.toggle("selected", t === el));
      };
      const expand = () => {
        expanded = expanded === null ? +el.dataset.tile : null;
        ptzOpen = false;
        render();
      };
      el.ondblclick = expand;
      el.ondragstart = (e) => {
        if (e.target.closest("button,select,input,summary,details")) {
          e.preventDefault();
          return;
        }
        dragging = true;
        e.dataTransfer.setData(
          "application/x-videowall",
          JSON.stringify({ tile: +el.dataset.tile }),
        );
        e.dataTransfer.effectAllowed = "move";
      };
      el.ondragover = (e) => {
        if ([...e.dataTransfer.types].includes("application/x-videowall")) {
          e.preventDefault();
          el.classList.add("drag-over");
        }
      };
      el.ondragleave = () => el.classList.remove("drag-over");
      el.ondrop = (e) => {
        dragging = false;
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove("drag-over");
        try {
          const data = JSON.parse(
              e.dataTransfer.getData("application/x-videowall"),
            ),
            target = +el.dataset.tile;
          if (
            Number.isInteger(data.tile) &&
            data.tile >= 0 &&
            data.tile < size
          ) {
            [slots[target], slots[data.tile]] = [
              slots[data.tile],
              slots[target],
            ];
            [fits[target], fits[data.tile]] = [fits[data.tile], fits[target]];
          } else if (model.sources.some((s) => s.id === data.source))
            slots[target] = data.source;
          else return;
          selected = target;
          render();
        } catch {
          toast("Не удалось перенести ячейку");
        }
      };
    });
    document.querySelectorAll("[data-video]").forEach(async (video) => {
      activePreview.add(video.dataset.video + "|" + video.dataset.fit);
      try {
        const p = await api(
          "/sources/" + video.dataset.video + "/preview",
          "POST",
          { fit: video.dataset.fit },
        );
        if (video.isConnected) play(video, p.hls);
      } catch (e) {
        if (video.isConnected)
          video.parentElement.querySelector(".play-status").textContent =
            e.message;
      }
    });
  } else if (view === "channels") {
    tb.innerHTML =
      '<div class="toolbar-title"><h2>Выходные каналы</h2><span>' +
      model.channels.length +
      " создано</span></div>" +
      (admin
        ? '<button class="primary" id="newChannel">＋ Создать канал</button>'
        : "");
    $("#main").innerHTML =
      '<div class="content list-content"><div class="channel-list data-list">' +
      model.channels
        .map(
          (c) =>
            '<article class="channel-row sortable-row" draggable="true" data-channel-order="'+c.id+'"><span class="drag-handle" title="Перетащить">⋮⋮</span><div class="channel-row__identity"><span class="channel-state" data-channel-state="'+c.status+'"></span><div><h3>' +
            esc(c.name) +
            '</h3><span>' + c.size + ' камер · ' + c.quality + ' · ' + c.fps + ' FPS · смотрят: <b data-viewers="' + c.id + '">' + (c.viewers == null ? '—' : c.viewers) + '</b></span></div></div><span class="badge" data-status="' +
            c.id +
            '">' +
            esc(statusName[c.status]) +
            '</span><span class="channel-row__metric">' + c.bitrate + ' кбит/с</span><span class="channel-row__metric" data-encoder="' +
            c.id +
            '">' +
            esc(c.effectiveEncoder) +
            '</span><div class="tools channel-row__actions">' +
            (admin
              ? '<button data-action="' +
                (c.desired ? "stop" : "start") +
                '" data-id="' +
                c.id +
                '">' +
                (c.desired ? "Остановить" : "Запустить") +
                '</button>'
              : "") +
            '<button data-watch="' + c.id + '">Смотреть</button><details class="action-menu"><summary aria-label="Дополнительные действия канала">Ещё</summary><div class="action-menu__items">' +
            (owner ? '<button data-edit="' +
                c.id +
                '">Открыть студию</button>'
              : "") +
            '<button data-links="' +
            c.id +
            '">Ссылки</button>' +
            (admin
              ? '<button class="danger-quiet" data-delete="' + c.id + '">Удалить</button>'
              : "") +
            '</div></details></div><p class="inline-message channel-row__error" data-error="' +
            c.id +
            '" style="overflow-wrap:anywhere">' +
            esc(c.reason || (c.status==="error"?"Канал переподключается":"")) +
            "</p></article>",
        )
        .join("") +
      "</div>" +
      (model.channels.length
        ? ""
        : '<div class="empty-state"><b>Нет выходных каналов</b><span>Соберите раскладку в разделе «Просмотр», затем создайте первый канал.</span></div>') +
      "</div>";
    enableOrdering("[data-channel-order]","channelOrder","/channels/order");
    if (admin)
      $("#newChannel").onclick = () => {
        editing = null;
        view = "wall";
        render();
        toast("Назначьте источники и нажмите «Создать канал»");
      };
    document.querySelectorAll("[data-action]").forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            b.disabled = true;
            await api(
              "/channels/" + b.dataset.id + "/" + b.dataset.action,
              "POST",
            );
            await refresh();
            render();
          } catch (e) {
            toast(e.message);
            b.disabled = false;
          }
        }),
    );
    document
      .querySelectorAll("[data-edit]")
      .forEach(
        (b) =>
          (b.onclick = () => (location.href = "/studio/" + b.dataset.edit)),
      );
    document.querySelectorAll("[data-delete]").forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            "Удалить канал?",
            "<p>Трансляция будет остановлена, настройки удалены.</p>",
            async () => {
              await api("/channels/" + b.dataset.delete, "DELETE");
              await refresh();
              render();
            },
            "Удалить",
          )),
    );
    document.querySelectorAll("[data-watch]").forEach(
      (b) =>
        (b.onclick = () => {
          const c = model.channels.find((c) => c.id === b.dataset.watch);
          window.location.href = c.watch;
        }),
    );
    document
      .querySelectorAll("[data-links]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            showLinks(model.channels.find((c) => c.id === b.dataset.links))),
      );
  } else if (view === "archive") {
    const a = model.archive || {
        settings: { jobs: [] },
        files: [],
        running: [],
        errors: {},
        disk: {},
      },
      cfg = a.settings || { jobs: [] },
      gb = (n) => (Number(n || 0) / 1073741824).toFixed(1),
      archiveMetric = (name, value, detail) =>
        '<article class="card"><p class="help">' +
        name +
        '</p><h2 style="margin:4px 0">' +
        value +
        '</h2><p class="help">' +
        detail +
        "</p></article>";
    tb.innerHTML =
      '<div class="toolbar-title"><h2>Запись и архив</h2><span>Хранение и экспорт видео</span></div><button id="archiveSettings">Хранилище</button><button class="primary" id="newRecording">+ Запись</button>';
    $("#main").innerHTML =
      '<div class="content"><div class="metrics">' +
      archiveMetric(
        "Файлы",
        a.files.length + " шт.",
        "Запущено заданий: " + a.running.length,
      ) +
      archiveMetric(
        "Свободно",
        gb(a.disk.free) + " ГБ",
        "Всего: " + gb(a.disk.total) + " ГБ",
      ) +
      archiveMetric(
        "Лимит архива",
        cfg.diskLimitGb + " ГБ",
        "Хранение: " + cfg.retentionDays + " дней",
      ) +
      '</div><div class="section-heading"><div><h3>Задания записи</h3><p>Что и когда сохранять</p></div></div><div class="cards">' +
      cfg.jobs
        .map(
          (j) =>
            '<article class="card entity-card"><div class="entity-card__head"><div><span class="eyebrow">Задание</span><h2>' +
            esc(j.name) +
            '</h2></div><span class="badge">' +
            (a.running.includes(j.id)
              ? "● Запись"
              : j.enabled
                ? "Ожидание"
                : "Выключено") +
            "</span></div><p>" +
            (j.type === "source" ? "Источник" : "Выходной канал") +
            " · " +
            (j.mode === "schedule" ? "По расписанию" : "Постоянно") +
            "</p>" +
            (a.errors[j.id]
              ? '<p class="help">' + esc(a.errors[j.id]) + "</p>"
              : "") +
            '<div class="tools entity-card__actions"><button data-record-edit="' +
            j.id +
            '">Настроить</button><button class="danger-quiet" data-record-remove="' +
            j.id +
            '">Удалить</button></div></article>',
        )
        .join("") +
      '</div><div class="section-heading"><div><h3>Записи</h3><p>Последние файлы архива</p></div></div><div class="data-list">' +
      (a.files
        .slice(0, 300)
        .map(
          (f) =>
            '<div class="data-row"><div><b>' +
            esc(f.jobName) +
            "</b> · " +
            esc(new Date(f.startedAt).toLocaleString()) +
            " · " +
            (f.size / 1048576).toFixed(1) +
            " МБ · " +
            (f.active ? "● пишется" : "") +
            '</div><div class="tools">' +
            (f.active
              ? ""
              : '<button data-archive-play="' +
                encodeURIComponent(f.id) +
                '">Смотреть и экспортировать</button> ') +
            (!f.active
              ? '<button data-archive-delete="' +
                encodeURIComponent(f.id) +
                '">Удалить</button></div></details>'
              : "") +
            "</div></div>",
        )
        .join("") || '<div class="empty-state compact"><b>Записей пока нет</b><span>Они появятся после запуска первого задания.</span></div>') +
      "</div></div>";
    const saveSettings = async (next) => {
      await api("/archive/settings", "PUT", next);
      await refresh();
      render();
    };
    $("#archiveSettings").onclick = () =>
      modal(
        "Хранилище архива",
        '<label>Максимальный размер, ГБ<input name="disk" type="number" min="1" max="10000" value="' +
          cfg.diskLimitGb +
          '"></label><label>Хранить, дней<input name="days" type="number" min="1" max="3650" value="' +
          cfg.retentionDays +
          '"></label><label>Длина одного файла, минут<input name="segment" type="number" min="1" max="60" value="' +
          cfg.segmentMinutes +
          '"></label><p class="help">При превышении срока или размера сначала удаляются самые старые завершённые записи.</p>',
        (f) =>
          saveSettings({
            ...cfg,
            diskLimitGb: +f.get("disk"),
            retentionDays: +f.get("days"),
            segmentMinutes: +f.get("segment"),
          }),
        "Сохранить",
      );
    const editJob = (j) => {
      const selected = j ? j.type + ":" + j.targetId : "",
        defaultName = j?.name || "Запись " + new Date().toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      modal(
        j ? "Задание записи" : "Новое задание",
        '<label>Название<input name="name" required maxlength="80" value="' +
          esc(defaultName) +
          '" autocomplete="off"></label><p class="help">Название можно изменить. Оно будет показано в архиве и имени задания.</p><label>Что записывать<select name="target" required><option value="">Выберите</option><optgroup label="Выходные каналы">' +
          model.channels
            .map(
              (c) =>
                '<option value="channel:' +
                c.id +
                '" ' +
                (selected === "channel:" + c.id ? "selected" : "") +
                ">" +
                esc(c.name) +
                "</option>",
            )
            .join("") +
          '</optgroup><optgroup label="Источники">' +
          model.sources
            .map(
              (s) =>
                '<option value="source:' +
                s.id +
                '" ' +
                (selected === "source:" + s.id ? "selected" : "") +
                ">" +
                esc(s.name) +
                "</option>",
            )
            .join("") +
          '</optgroup></select></label><label><input name="enabled" type="checkbox" ' +
          (!j || j.enabled ? "checked" : "") +
          '> Запись включена</label><label>Режим<select name="mode"><option value="always">Постоянно</option><option value="schedule" ' +
          (j?.mode === "schedule" ? "selected" : "") +
          '>Ежедневно по расписанию</option></select></label><label>Начало<input name="from" type="time" value="' +
          (j?.schedule?.windows?.[0]?.from || "00:00") +
          '"></label><label>Окончание<input name="to" type="time" value="' +
          (j?.schedule?.windows?.[0]?.to || "23:59") +
          '"></label>',
        async (f) => {
          const name = String(f.get("name") || "").trim();
          if (!name) throw Error("Введите название записи");
          const [type, targetId] = f.get("target").split(":");
          if (!type || !targetId) throw Error("Выберите источник или выходной канал");
          const job = {
            id: j?.id,
            name,
            type,
            targetId,
            enabled: f.has("enabled"),
            mode: f.get("mode"),
            schedule: {
              enabled: true,
              windows: [
                {
                  days: [0, 1, 2, 3, 4, 5, 6],
                  from: f.get("from"),
                  to: f.get("to"),
                },
              ],
            },
          };
          await saveSettings({
            ...cfg,
            jobs: j
              ? cfg.jobs.map((x) => (x.id === j.id ? job : x))
              : [...cfg.jobs, job],
          });
        },
        "Сохранить",
      );
      requestAnimationFrame(() => {
        const nameInput = $("#dialog [name=name]");
        if (nameInput) { nameInput.focus(); nameInput.select(); }
      });
    };
    $("#newRecording").onclick = () => editJob(null);
    document
      .querySelectorAll("[data-record-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            editJob(cfg.jobs.find((j) => j.id === b.dataset.recordEdit))),
      );
    document.querySelectorAll("[data-record-remove]").forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            "Удалить задание?",
            "<p>Записанные файлы останутся в архиве.</p>",
            () =>
              saveSettings({
                ...cfg,
                jobs: cfg.jobs.filter((j) => j.id !== b.dataset.recordRemove),
              }),
            "Удалить",
          )),
    );
    document.querySelectorAll("[data-archive-play]").forEach(
      (b) =>
        (b.onclick = async () => {
          const id = decodeURIComponent(b.dataset.archivePlay);
          b.disabled = true;
          const oldText = b.textContent;
          b.textContent = "Подготовка…";
          let playback;
          try {
            playback = await api("/archive/playback", "POST", { fileId: id });
          } catch (error) {
            toast("Не удалось открыть запись: " + error.message);
            b.disabled = false;
            b.textContent = oldText;
            return;
          }
          b.disabled = false;
          b.textContent = oldText;
          modal(
            "Просмотр записи",
            '<video controls preload="metadata" style="width:100%;max-height:55vh;background:#000" src="' +
              esc(playback.url) +
              '"></video><p class="help">'+(playback.converted?'Запись автоматически подготовлена в формате, совместимом с браузером.':'Запись готова к просмотру.')+'</p><label>Начало фрагмента, секунд<input name="offset" type="number" min="0" value="0"></label><label>Длина фрагмента, секунд<input name="duration" type="number" min="1" max="3600" value="60"></label><p class="help">Выберите момент в плеере, укажите секунду начала и длину — будет создан отдельный MP4.</p>',
            async (f) => {
              const x = await api("/archive/export", "POST", {
                fileId: id,
                offsetSec: +f.get("offset"),
                durationSec: +f.get("duration"),
              });
              location.href = x.url;
            },
            "Экспортировать MP4",
          );
        }),
    );
    document.querySelectorAll("[data-archive-delete]").forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            "Удалить запись?",
            "<p>Файл будет удалён без возможности восстановления.</p>",
            async () => {
              await api("/archive/files/" + b.dataset.archiveDelete, "DELETE");
              await refresh();
              render();
            },
            "Удалить",
          )),
    );
  } else if (view === "users") {
    tb.innerHTML =
      '<div class="toolbar-title"><h2>Пользователи и доступ</h2><span>Роли, сеансы и история действий</span></div><button class="primary" id="newUser">+ Пользователь</button>';
    const roleName = {
      admin: "Администратор",
      operator: "Оператор",
      viewer: "Зритель",
    };
    $("#main").innerHTML =
      '<div class="content"><div class="cards">' +
      (model.users || [])
        .map(
          (u) =>
            '<article class="card"><span class="badge">' +
            esc(roleName[u.role] || u.role) +
            "</span><h2>" +
            esc(u.username) +
            "</h2><p>" +
            (u.enabled ? "Доступ активен" : "Заблокирован") +
            "<br>Каналов: " +
            (u.role === "admin" ? "все" : u.channels.length) +
            '</p><button data-user-edit="' +
            u.id +
            '">Настроить</button> ' +
            (u.id !== model.currentUser?.id
              ? '<button data-user-revoke="' +
                u.id +
                '">Отозвать доступ</button>'
              : "") +
            "</article>",
        )
        .join("") +
      '</div><div class="section-heading"><div><h3>Активные сеансы</h3><p>Подключённые устройства</p></div></div><div class="data-list">' +
      ((model.sessions || [])
        .map(
          (s) =>
            '<div class="data-row"><div><b>' +
            esc(s.username) +
            "</b> · " +
            esc(s.ip) +
            " · " +
            esc(new Date(s.createdAt).toLocaleString()) +
            '</div><button data-session-revoke="' +
            s.id +
            '">Отключить</button></div>',
        )
        .join("") || "<p>Нет активных сеансов.</p>") +
      '</div><div class="section-heading"><div><h3>Журнал действий</h3><p>Последние изменения системы</p></div></div><div class="data-list">' +
      ((model.audit || [])
        .slice(0, 50)
        .map(
          (a) =>
            '<div class="data-row audit-row"><b>' +
            esc(new Date(a.created_at).toLocaleString()) +
            " · " +
            esc(a.username) +
            "</b><br>" +
            esc(a.action) +
            " · " +
            esc(a.target) +
            "</div>",
        )
        .join("") || '<div class="empty-state compact"><b>Действий пока нет</b></div>') +
      "</div></div>";
    const editUser = (u) =>
      modal(
        u ? "Настройка пользователя" : "Новый пользователь",
        '<label>Логин<input name="username" required pattern="[a-z0-9._-]{3,32}" ' +
          (u ? 'readonly value="' + esc(u.username) + '"' : "") +
          "></label><label>" +
          (u ? "Новый пароль (оставьте пустым, чтобы не менять)" : "Пароль") +
          '<input name="password" type="password" ' +
          (u ? "" : "required") +
          ' minlength="10"></label><label>Роль<select name="role"><option value="viewer">Зритель</option><option value="operator" ' +
          (u?.role === "operator" ? "selected" : "") +
          '>Оператор</option><option value="admin" ' +
          (u?.role === "admin" ? "selected" : "") +
          '>Администратор</option></select></label><label><input type="checkbox" name="enabled" ' +
          (!u || u.enabled ? "checked" : "") +
          "> Доступ активен</label><h3>Доступные каналы</h3>" +
          model.channels
            .map(
              (c) =>
                '<label><input type="checkbox" name="channel" value="' +
                c.id +
                '" ' +
                (u?.channels.includes(c.id) ? "checked" : "") +
                "> " +
                esc(c.name) +
                "</label>",
            )
            .join(""),
        async (f) => {
          const data = {
            username: f.get("username"),
            password: f.get("password"),
            role: f.get("role"),
            enabled: f.has("enabled"),
            channels: f.getAll("channel"),
          };
          await api(u ? "/users/" + u.id : "/users", u ? "PUT" : "POST", data);
          await refresh();
          render();
        },
        "Сохранить",
      );
    $("#newUser").onclick = () => editUser(null);
    document
      .querySelectorAll("[data-user-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            editUser(model.users.find((u) => u.id === b.dataset.userEdit))),
      );
    document.querySelectorAll("[data-user-revoke]").forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            "Отозвать доступ?",
            "<p>Пользователь будет отключён на всех устройствах, включая VLC.</p>",
            async () => {
              await api("/users/" + b.dataset.userRevoke, "DELETE");
              await refresh();
              render();
            },
            "Отозвать",
          )),
    );
    document.querySelectorAll("[data-session-revoke]").forEach(
      (b) =>
        (b.onclick = async () => {
          await api("/sessions/" + b.dataset.sessionRevoke, "DELETE");
          await refresh();
          render();
        }),
    );
  } else if (view === "automation") {
    tb.innerHTML = '<div class="toolbar-title"><h2>Автоматизация</h2><span>Автозапуск, расписания и резервирование</span></div>';
    $("#main").innerHTML =
      '<div class="content"><div class="card"><h2>Автоматизация</h2><p>Сервер: <b>' +
      (model.serviceMode
        ? "служба Windows, работает до входа пользователя"
        : "обычный запуск") +
      '</b></p><p class="help">Расписание проверяется каждые 30 секунд. При потере основной камеры канал переключится на резервную.</p></div><div class="cards">' +
      model.channels
        .map(
          (c) =>
            '<article class="card"><h2>' +
            esc(c.name) +
            "</h2><p>Автозапуск: <b>" +
            (c.automation?.autoStart !== false ? "да" : "нет") +
            "</b><br>Расписание: <b>" +
            (c.automation?.schedule?.enabled ? "включено" : "выключено") +
            "</b><br>Резервов: <b>" +
            (c.backups || []).filter(Boolean).length +
            "</b><br>Задержка: <b>" +
            (c.fallbackDelay || 5) +
            ' с</b></p><button data-auto="' +
            c.id +
            '">Настроить</button></article>',
        )
        .join("") +
      "</div></div>";
    document.querySelectorAll("[data-auto]").forEach(
      (b) =>
        (b.onclick = () => {
          const c = model.channels.find((x) => x.id === b.dataset.auto),
            a = c.automation || {},
            w = a.schedule?.windows?.[0] || { from: "00:00", to: "23:59" };
          modal(
            "Автоматизация · " + c.name,
            '<label><input name="autoStart" type="checkbox" ' +
              (a.autoStart !== false ? "checked" : "") +
              '> Автозапуск</label><label><input name="schedule" type="checkbox" ' +
              (a.schedule?.enabled ? "checked" : "") +
              '> Использовать расписание ежедневно</label><label>Начало<input name="from" type="time" value="' +
              w.from +
              '"></label><label>Окончание<input name="to" type="time" value="' +
              w.to +
              '"></label><label>Переключать через, секунд<input name="delay" type="number" min="4" max="60" value="' +
              (c.fallbackDelay || 5) +
              '"></label><div class="form-note"><b>Резервные источники</b><span>Для каждой занятой ячейки можно выбрать запасную камеру. Если основной поток пропадёт, STREAMHUB подождёт указанное время и автоматически переключится на резерв.</span></div>' +
              c.slots
                .map(
                  (sid, i) =>
                    "<label>Резерв для «" +
                    esc(model.sources.find((source) => source.id === sid)?.name || "Ячейка " + (i + 1)) +
                    "»" +
                    '<select name="backup' +
                    i +
                    '"><option value="">Нет</option>' +
                    model.sources
                      .filter((s) => s.id !== sid)
                      .map(
                        (s) =>
                          '<option value="' +
                          s.id +
                          '" ' +
                          (c.backups?.[i] === s.id ? "selected" : "") +
                          ">" +
                          esc(s.name) +
                          "</option>",
                      )
                      .join("") +
                    "</select><span class=\"field-help\">Эта камера автоматически заменит основной источник при потере сигнала.</span></label>",
                )
                .join("") +
              '<label>Текст заглушки<input name="placeholder" maxlength="80" value="' +
              esc(a.placeholder?.text || "НЕТ СИГНАЛА") +
              '"></label>',
            async (f) => {
              await api("/channels/" + c.id + "/automation", "PUT", {
                automation: {
                  autoStart: f.has("autoStart"),
                  schedule: {
                    enabled: f.has("schedule"),
                    windows: [
                      {
                        days: [0, 1, 2, 3, 4, 5, 6],
                        from: f.get("from"),
                        to: f.get("to"),
                      },
                    ],
                  },
                  placeholder: { text: f.get("placeholder"), color: "#161f26" },
                },
                fallbackDelay: +f.get("delay"),
                backups: c.slots.map((_, i) => f.get("backup" + i) || null),
              });
              await refresh();
              render();
            },
            "Сохранить",
          );
        }),
    );
  } else if (view === "events") {
    tb.innerHTML =
      '<div class="toolbar-title"><h2>События</h2><span>Состояние источников и служб</span></div><button id="ackEvents">Отметить просмотренными</button>';
    $("#main").innerHTML =
      '<div class="content"><div class="card"><h2>Журнал работы</h2><p class="help">Сбои источников, кодировщиков, расписаний и резервного копирования.</p></div>' +
      ((model.events || [])
        .map(
          (e) =>
            '<div class="event-row"><b>' +
            esc(new Date(e.created_at).toLocaleString()) +
            " · " +
            esc(e.type) +
            "</b><br>" +
            esc(e.message) +
            "</div>",
        )
        .join("") || "<p>Событий пока нет.</p>") +
      "</div>";
    $("#ackEvents").onclick = async () => {
      await api("/events/acknowledge", "POST");
      toast("События отмечены");
    };
  } else if (view === "monitoring") {
    tb.innerHTML = '<div class="toolbar-title"><h2>Мониторинг камер</h2><span id="monitorSummary">Проверяем доступность…</span></div><button id="refreshMonitoring">Обновить</button>';
    $("#main").innerHTML = '<div class="content monitor-content"><div id="monitorFree"></div><div id="monitorGrid" class="monitor-grid"><div class="empty-state"><b>Проверяем камеры</b><span>Обычно это занимает несколько секунд.</span></div></div></div>';
    const loadMonitoring = async () => {
      const button = $("#refreshMonitoring");
      if (button) button.disabled = true;
      try {
        const data = await api("/monitoring");
        if (view !== "monitoring") return;
        const assigned = new Set(model.channels.flatMap(channel => channel.slots || []));
        const free = model.sources.filter(source => !assigned.has(source.id));
        $("#monitorFree").innerHTML = model.role === "viewer" ? "" : '<section class="monitor-free"><strong>Свободные источники · ' + free.length + '</strong><p>Не используются в раскладках каналов</p>' +
          (free.length ? '<div>' + free.map(source => '<span title="' + esc(source.description || source.name) + '">' + esc(source.name) + '</span>').join('') + '</div>' : '<p>Все источники используются</p>') + '</section>';
        const online = data.sources.filter((source) => source.status === "online").length;
        $("#monitorSummary").textContent = online + " из " + data.sources.length + " передают видео" + (data.refreshing ? " · идёт проверка" : "");
        $("#monitorGrid").innerHTML = data.sources.length ?
          '<div class="monitor-table-head" aria-hidden="true"><span>Камера</span><span>Адрес</span><span>Ping</span><span>Поток</span><span>Проверено</span><span></span></div>' +
          data.sources.map((source) => {
            const pingText = 'Ping: ' + (source.ping == null ? '—' : source.ping ? 'есть' : 'нет');
            const streamText = 'Порт: ' + (source.tcp == null ? '—' : source.tcp ? 'открыт' : 'закрыт');
            return '<article class="monitor-card '+(source.status === 'online' ? 'is-online' : source.status === 'reachable' ? 'is-reachable' : source.status === 'checking' || source.status === 'connecting' || source.status === 'disabled' ? 'is-checking' : 'is-offline')+'" data-monitor-id="'+esc(source.id)+'" tabindex="0" role="button" aria-label="История: '+esc(source.name)+'" title="Открыть историю: '+esc(source.name)+'">'+
              '<div class="monitor-card__head"><span class="monitor-light" aria-hidden="true"></span><div><h3>'+esc(source.name)+'</h3><p>'+(StreamhubMonitoring.labels[source.status] || 'Нет видео')+'</p></div></div>'+
              '<span class="monitor-cell monitor-address is-muted" title="'+esc(source.host || '')+'">'+esc(source.host || (source.kind === 'capture' ? 'Локальный захват' : '—'))+'</span>'+
              '<span class="monitor-cell monitor-ping '+(source.ping === false?'is-bad':source.ping?'is-good':'is-muted')+'">'+pingText+'</span>'+
              '<span class="monitor-cell monitor-stream '+(source.tcp === false?'is-bad':source.tcp?'is-good':'is-muted')+'">'+streamText+'</span>'+
              '<span class="monitor-cell monitor-checked is-muted">'+(source.checkedAt ? new Date(source.checkedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : 'Ожидание')+'</span>'+
              '<span class="monitor-action-placeholder"></span>'+
              (source.reason?'<p class="monitor-reason" title="'+esc(source.reason)+'">'+esc(source.reason)+'</p>':'')+'</article>';
          }).join('') : '<div class="empty-state"><b>Источники не добавлены</b><span>После добавления камер их состояние появится здесь автоматически.</span></div>';
        document.querySelectorAll("[data-monitor-id]").forEach(card => {
          const open = async () => {
            try {
              const source = data.sources.find(item => item.id === card.dataset.monitorId);
              const { points } = await api("/monitoring/" + encodeURIComponent(source.id) + "/history");
              const {start, bins, outages: breaks} = StreamhubMonitoring.timeline(points);
              const bars = bins.map((bin,i) => {
                const label = new Date(bin.start).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
                return '<rect x="'+(i*2.5)+'" y="4" width="2.5" height="42" fill="'+(StreamhubMonitoring.colors[bin.status] || '#34434d')+'"><title>'+esc(label+' · '+(bin.status ? bin.reason || StreamhubMonitoring.labels[bin.status] || 'Нет видео' : 'Нет проверок'))+'</title></rect>';
              }).join('') + Array.from({length:5}, (_,i) => '<text x="'+(i*180)+'" y="66" text-anchor="'+(i===0?'start':i===4?'end':'middle')+'" fill="#afc2ce" font-size="16">'+esc(new Date(start+i*21600000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}))+'</text>').join('');
              modal("История: " + esc(source.name),
                '<p>Последние 24 часа · зелёный — поток идёт, жёлтый — адрес доступен без видео, красный — связи нет. Проверка каждые 15 секунд; интервалы по 5 минут показывают худшее состояние. Серый — нет проверок.</p>' +
                '<svg class="monitor-history" viewBox="0 0 720 76" role="img" aria-label="График состояния за сутки"><rect width="720" height="46" fill="#18232a"/>' + bars + '</svg>' +
                '<p>Периоды без видео: ' + breaks.length + '</p><div class="monitor-outages">' + (breaks.length ? breaks.slice(-30).reverse().map(point => '<p>' + esc(new Date(point.start).toLocaleString() + ' → ' + (point.end ? new Date(point.end).toLocaleTimeString() + (point.unknownEnd ? ' · далее нет проверок' : '') : 'восстановление не зафиксировано') + ' · ' + point.reason) + '</p>').join("") : '<p>Обрывов в истории нет</p>') + '</div>',
                () => {}, "Закрыть");
              $("#dialog").classList.add("monitor-history-dialog");
              $("#cancel").hidden=true;
            } catch (error) { toast(error.message); }
          };
          card.onclick = open;
          card.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } };
        });
      } catch (error) {
        if (view === "monitoring") $("#monitorGrid").innerHTML = '<div class="empty-state"><b>Не удалось получить состояние</b><span>'+esc(error.message)+'</span></div>';
      } finally { if (button?.isConnected) button.disabled = false; }
    };
    $("#refreshMonitoring").onclick = loadMonitoring;
    loadMonitoring();
  } else if (view === "diagnostics") {
    const d = model.diagnostics || {},
      fmtBytes = (n) =>
        Number.isFinite(n) ? (n / 1073741824).toFixed(1) + " ГБ" : "—",
      fmtTime = (ms) => {
        if (!ms) return "—";
        const total = Math.floor(ms / 1000),
          h = Math.floor(total / 3600),
          m = Math.floor((total % 3600) / 60),
          s = total % 60;
        return [h, m, s].map((x) => String(x).padStart(2, "0")).join(":");
      },
      metric = (name, value, detail) =>
        '<div class="diag-summary-row"><span>' +
        name +
        '</span><strong>' +
        value +
        '</strong><small>' +
        detail +
        "</small></div>";
    tb.innerHTML =
      '<div class="toolbar-title"><h2>Диагностика</h2><span>Ресурсы, потоки и кодировщики</span></div><button id=diagRefresh>Обновить</button>';
    $("#main").innerHTML =
      '<div class="content"><div class="diagnostic-summary data-list">' +
      metric(
        "CPU компьютера",
        (d.cpuPercent ?? 0).toFixed(1) + "%",
        "Общая загрузка системы",
      ) +
      metric(
        "Оперативная память",
        fmtBytes(d.ramUsed),
        "из " + fmtBytes(d.ramTotal),
      ) +
      metric(
        "GPU",
        d.gpu ? d.gpu.utilization + "%" : "Не определяется",
        d.gpu
          ? esc(d.gpu.name) +
              " · " +
              d.gpu.memoryUsedMb +
              " / " +
              d.gpu.memoryTotalMb +
              " МБ"
          : "NVIDIA GPU не найдена; Intel/AMD покажут метрики каналов без общей загрузки GPU",
      ) +
      metric(
        "Медиапроцессы",
        (d.channelEncoderCount || 0) + " каналов",
        (d.sourceDecoderCount || 0) +
          " декодеров · " +
          (d.previewCount || 0) +
          " предпросмотров",
      ) +
      '</div><h3 style="margin-top:24px">Каналы</h3><div class="diagnostic-channels data-list">' +
      model.channels
        .map((c) => {
          const fps = Number(c.actual?.fps || 0),
            speed = Number(c.actual?.speed || 0),
            process = c.process || {},
            warning =
              c.status === "live" && fps >= c.fps * 0.9 && speed >= 0.9
                ? "Работает нормально"
                : c.status === "stopped"
                  ? "Канал остановлен"
                  : c.reason || "Поток запускается или не успевает кодировать";
          return (
            '<article class="diag-channel-row"><div class="diag-channel-name"><span class="badge">' +
            esc(statusName[c.status] || c.status) +
            "</span><strong>" +
            esc(c.name) +
            "</strong></div><span>FPS <b>" +
            fps.toFixed(1) +
            " / " +
            c.fps +
            "</b></span><span>Битрейт <b>" +
            Number(c.actual?.bitrateKbps || 0).toFixed(0) +
            " кбит/с</b></span><span>Скорость <b>" +
            speed.toFixed(2) +
            "×</b></span><span>CPU <b>" +
            Number(process.cpuPercent || 0).toFixed(1) +
            "%</b></span><span>RAM <b>" +
            (process.ramBytes ? Math.round(process.ramBytes / 1048576) : 0) +
            " МБ</b></span><span>Аптайм <b>" +
            fmtTime(c.uptimeMs) +
            "</b></span><span>Перезапуски <b>" +
            (c.restarts || 0) +
            '</b></span><small class="diag-channel-note">' +
            esc(warning) +
            "</small>" +
            (c.error
              ? '<details class="diag-channel-error"><summary>Причина</summary><p class="help">' +
                esc(c.error) +
                "</p></details>"
              : "") +
            "</article>"
          );
        })
        .join("") +
      '</div><h3 style="margin-top:24px">Проверка кодировщиков</h3><div class="card"><p class="help">Тест создаёт двухсекундное видео 640×360 и проверяет реальный запуск кодировщика.</p><div class="tools" id=encoderTests>' +
      model.encoders
        .map(
          (e) =>
            '<button data-test-encoder="' +
            e +
            '">Проверить ' +
            e +
            "</button>",
        )
        .join("") +
      "</div><p id=encoderResult class=help></p></div></div>";
    $("#diagRefresh").onclick = async () => {
      await refresh();
      render();
    };
    document.querySelectorAll("[data-test-encoder]").forEach(
      (b) =>
        (b.onclick = async () => {
          const result = $("#encoderResult");
          b.disabled = true;
          result.textContent = "Проверяем " + b.dataset.testEncoder + "…";
          try {
            const x = await api("/diagnostics/encoders/test", "POST", {
              encoder: b.dataset.testEncoder,
            });
            result.textContent =
              (x.ok ? "Готово: " : "Не работает: ") +
              x.reason +
              " (" +
              (x.durationMs / 1000).toFixed(1) +
              " с)";
          } catch (e) {
            result.textContent = e.message;
          } finally {
            b.disabled = false;
          }
        }),
    );
  } else if (view === "sources") {
    tb.innerHTML =
      '<div class="toolbar-title"><h2>Источники</h2><span>' +
      model.sources.length +
      ' подключено</span></div><label class="toolbar-search"><span class="visually-hidden">Поиск по камерам</span><input id="sourcesSearch" type="search" placeholder="Найти камеру…" value="' + esc(sourcePageQuery) + '" autocomplete="off"></label>' +
      (admin
        ? '<button id="discoverOnvif">Найти ONVIF-камеры</button><button class="primary" id="newSource">＋ Добавить</button>'
        : "");
    const visibleSources = model.sources.filter((s) => {
      const query = sourcePageQuery.trim().toLowerCase();
      return !query || [s.name, s.description, s.url, statusName[s.status], s.reason, s.error]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
    $("#main").innerHTML =
      '<div class="content">' +
      (visibleSources.length ? visibleSources
        .map(
          (s) =>
            '<div class="row source-row sortable-row" draggable="true" data-source-order="'+s.id+'"><span class="drag-handle" title="Перетащить">⋮⋮</span><div><strong>' +
            esc(s.name) +
            '</strong><p class="help"><span class="source-status" data-source-id="'+esc(s.id)+'" data-source-state="'+esc(s.status)+'">' +
            esc(statusName[s.status]) + '</span>' +
            " · " +
            esc(s.quality) + (s.capture ? " · "+(s.capture.kind==="screen"?"Захват экрана":s.capture.kind==="window"?"Захват окна":"Видеоустройство") : " · "+String(s.transport||"tcp").toUpperCase()) +
            '</p>'+(s.description?'<p class="source-description">'+esc(s.description)+'</p>':'')+'<p class="help">' +
            esc(s.enabled===0?"Источник выключен":s.reason || (s.error?"Ошибка подключения · подробности ниже":"")) +
            '</p>'+(s.enabled!==0&&s.error?'<details class="source-technical-error"><summary>Техническая причина</summary><pre>'+esc(s.error)+'</pre></details>':'')+'</div><div class="tools"><button data-open-source="' +
            s.id +
            '">Просмотр</button>' +
            (admin
              ? '<details class="action-menu"><summary aria-label="Дополнительные действия источника">Ещё</summary><div class="action-menu__items"><button data-toggle-source="'+s.id+'" data-enabled="'+(s.enabled!==0)+'">'+(s.enabled===0?"Включить":"Выключить")+'</button>'+(s.capture?"":'<button data-onvif-source="' + s.id + '">' + (s.onvif ? "PTZ и управление" : "Подключить ONVIF") + '</button>')+'<button data-edit-source="' +
                s.id +
                '">Изменить</button><button data-remove="' +
                s.id +
                '">Удалить</button></div></details>'
              : "") +
            "</div></div>",
        )
        .join("") : '<div class="empty-state"><b>Камеры не найдены</b><span>Измените запрос или очистите строку поиска.</span></div>') +
      "</div>";
    enableOrdering("[data-source-order]","sourceOrder","/sources/order");
    const sourceSearch = $("#sourcesSearch");
    sourceSearch.oninput = () => {
      sourcePageQuery = sourceSearch.value;
      render();
      const next = $("#sourcesSearch");
      next.focus();
      next.setSelectionRange(next.value.length, next.value.length);
    };
    if (admin) {
      $("#newSource").onclick = () => addSource();
      $("#discoverOnvif").onclick = discoverOnvif;
      document.querySelectorAll("[data-onvif-source]").forEach((button) => {
        button.onclick = () => {
          const source = model.sources.find((item) => item.id === button.dataset.onvifSource);
          source.onvif ? openPtz(source) : configureOnvif(source);
        };
      });
      document.querySelectorAll("[data-toggle-source]").forEach((button)=>button.onclick=async()=>{button.disabled=true;try{await api("/sources/"+button.dataset.toggleSource+"/"+(button.dataset.enabled==="true"?"disable":"enable"),"POST");await refresh();render()}catch(e){toast(e.message);button.disabled=false}});
    }
    document.querySelectorAll("[data-open-source]").forEach(
      (b) =>
        (b.onclick = () => {
          slots = [b.dataset.openSource];
          size = 1;
          view = "wall";
          render();
        }),
    );
    document
      .querySelectorAll("[data-edit-source]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            addSource(
              model.sources.find((s) => s.id === b.dataset.editSource),
            )),
      );
    document.querySelectorAll("[data-remove]").forEach(
      (b) =>
        (b.onclick = () =>
          modal(
            "Удалить источник?",
            "<p>Источник можно удалить, если он не используется в каналах.</p>",
            async () => {
              await api("/sources/" + b.dataset.remove, "DELETE");
              slots = slots.map((s) => (s === b.dataset.remove ? null : s));
              await refresh();
              render();
            },
            "Удалить",
          )),
    );
  } else {
    tb.innerHTML = '<div class="toolbar-title"><h2>Настройки</h2><span>Система, сеть и резервные копии</span></div><button id="logout">Выйти</button>';
    $("#main").innerHTML =
      '<div class="content settings-layout"><div class="card system-card"><span class="eyebrow">Состояние системы</span><h2>STREAMHUB 1.6.6</h2><p>Режим: ' +
      (model.serviceMode ? "служба Windows" : "обычный запуск") +
      "<br>FFmpeg: " +
      (model.dependencies.ffmpeg ? "найден" : "не установлен") +
      "<br>MediaMTX: " +
      (model.dependencies.mediamtx ? "найден" : "не установлен") +
      "<br>Медиасервер: " +
      (model.mediaReady ? "работает" : "недоступен") +
      "</p><p>Закрытие окна сворачивает приложение в трей. Для остановки сервера выберите «Завершить» в меню трея.</p><div class=\"network-status\"><b>Сетевой доступ: " +
      (model.network.lan ? "работает" : model.network.pendingRestart ? "ожидает перезапуска" : "выключен") +
      "</b><span>Фактический адрес: " + esc(model.network.bindAddress || "127.0.0.1") +
      ":" + model.network.port + " · RTSP: " + (model.network.rtspPort || 8554) + "</span></div>" +
      (admin
        ? '<div class="tools"><button id="networkSettings">Настроить доступ</button><button id="networkCheck">Проверить порты</button></div><p id="networkCheckResult" class="help"></p>'
        : "") +
      "<p>Расписания, резервные источники, журнал событий и резервное копирование настроек.</p></div>" +
      (admin
        ? '<h3 style="margin-top:24px">Резервные копии</h3><div class="card"><button id="backupCreate">Создать копию</button> <button id="backupImport">Импортировать</button><input hidden type="file" id="backupFile" accept=".vwbak"><p class="help">Ежедневная копия создаётся автоматически. Восстановление применяется после перезапуска компьютера.</p>' +
          (model.backups || [])
            .map(
              (b) =>
                "<p>" +
                esc(new Date(b.createdAt).toLocaleString()) +
                " · " +
                Math.ceil(b.size / 1024) +
                ' КБ <a href="/backup/' +
                encodeURIComponent(b.id) +
                '">Скачать</a> <button data-restore="' +
                b.id +
                '">Восстановить</button> <button data-backup-delete="' +
                b.id +
                '">Удалить</button></p>',
            )
            .join("") +
          "</div>"
        : "") +
      (admin
        ? '<h3 style="margin-top:24px">Последние события</h3>' +
          model.logs
            .slice(-10)
            .reverse()
            .map(
              (l) =>
                '<p class="help" style="overflow-wrap:anywhere">' +
                esc(l.at + " · " + l.who + " · " + l.message) +
                "</p>",
            )
            .join("")
        : "") +
      "</div>";
    if (admin) {
      $("#networkSettings").onclick = () =>
        modal(
          "Сетевой доступ",
          '<label><input type="checkbox" name="lan" ' +
            (model.network.nextLan ? "checked" : "") +
            '> Разрешить подключения из локальной сети</label><label>Внешний IP или домен<input name="publicHost" placeholder="example.org или 203.0.113.10" value="' +
            esc(model.network.publicHost || "") +
            '"></label><p class="help">Адрес используется для готовых ссылок. Протокол и порт указывать не нужно.</p>',
          async (form) => {
            const result = await api("/network", "PUT", {
              lan: form.has("lan"),
              publicHost: form.get("publicHost"),
            });
            if (result.restarting) {
              session = false;
              toast("Служба перезапускается. Подождите несколько секунд…");
              const restored = await waitForServerRestart();
              if (!restored) throw Error("Служба не вернулась в течение 30 секунд");
              toast("Сетевой режим применён");
            } else {
              await refresh();
              render();
              toast(result.restartRequired ? "Настройка сохранена. Перезапустите приложение." : "Настройка применена");
            }
          },
          "Применить",
        );
      $("#networkCheck").onclick = async () => {
        const output = $("#networkCheckResult"), button = $("#networkCheck");
        button.disabled = true;
        output.textContent = "Проверяем привязку HTTP и RTSP…";
        try {
          const check = await api("/network/check");
          output.textContent = check.results.length
            ? check.results.map((x) => x.protocol + " " + x.address + ":" + x.port + " — " + (x.ok ? "доступен" : "недоступен (" + x.error + ")")).join(" · ")
            : "Сетевые IPv4-адреса не найдены.";
        } catch (error) {
          output.textContent = error.message;
        } finally {
          button.disabled = false;
        }
      };
    }
    if (admin) {
      $("#backupCreate").onclick = async () => {
        await api("/backups", "POST");
        await refresh();
        render();
      };
      $("#backupImport").onclick = () => $("#backupFile").click();
      $("#backupFile").onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const data = await new Promise((ok, no) => {
          const r = new FileReader();
          r.onload = () => ok(String(r.result).split(",")[1]);
          r.onerror = no;
          r.readAsDataURL(file);
        });
        await api("/backups/import", "POST", { data });
        await refresh();
        render();
      };
      document.querySelectorAll("[data-restore]").forEach(
        (b) =>
          (b.onclick = () =>
            modal(
              "Восстановить настройки?",
              "<p>Текущие настройки будут заменены после перезапуска компьютера.</p>",
              async () => {
                await api("/backups/" + b.dataset.restore + "/restore", "POST");
                toast("Перезапустите компьютер для завершения");
              },
              "Восстановить",
            )),
      );
      document.querySelectorAll("[data-backup-delete]").forEach(
        (b) =>
          (b.onclick = async () => {
            await api("/backups/" + b.dataset.backupDelete + "/delete", "POST");
            await refresh();
            render();
          }),
      );
    }
    $("#logout").onclick = async () => {
      await api("/logout", "POST");
      session = false;
      login();
    };
  }
  renderedView=view;
  requestAnimationFrame(()=>{const content=document.querySelector("#main > .content");if(content)content.scrollTop=scrollPositions[view]||0});
}

function enableOrdering(selector,dataKey,endpoint){
  let moving=null;
  document.querySelectorAll(selector).forEach((row)=>{
    row.ondragstart=(e)=>{if(e.target.closest("button,input,select,summary,details")){e.preventDefault();return;}moving=row.dataset[dataKey];e.dataTransfer.effectAllowed="move";row.classList.add("is-dragging")};
    row.ondragend=()=>{moving=null;row.classList.remove("is-dragging")};
    row.ondragover=(e)=>{if(moving&&moving!==row.dataset[dataKey]){e.preventDefault();row.classList.add("drag-over-row")}};
    row.ondragleave=()=>row.classList.remove("drag-over-row");
    row.ondrop=async(e)=>{e.preventDefault();row.classList.remove("drag-over-row");if(!moving||moving===row.dataset[dataKey])return;const ids=[...document.querySelectorAll(selector)].map((x)=>x.dataset[dataKey]),from=ids.indexOf(moving),to=ids.indexOf(row.dataset[dataKey]);ids.splice(to,0,ids.splice(from,1)[0]);try{await api(endpoint,"PUT",{ids});await refresh();render()}catch(err){toast(err.message)}};
  });
}

function layoutSnapshot() {
  return {
    size,
    slots: Array.from({ length: size }, (_, i) => slots[i] || null),
    fits: Array.from({ length: size }, (_, i) => fits[i] || "cover"),
  };
}
function manageLayout() {
  const l = model.layouts.find((l) => l.id === savedLayout);
  if (!l) return;
  modal(
    "Управление сохранённым видом",
    '<label>Название<input name="name" required maxlength="80" value="' +
      esc(l.name) +
      '"></label><label>Действие<select name="action"><option value="rename">Переименовать</option><option value="update">Обновить текущим экраном</option><option value="delete">Удалить сохранённый вид</option></select></label><p class="help">Сохранённый вид запоминает сетку, выбранные камеры и способ заполнения ячеек. Он не изменяет уже созданные выходные каналы.</p>',
    async (f) => {
      const action = f.get("action");
      const layouts =
        action === "delete"
          ? model.layouts.filter((x) => x.id !== l.id)
          : model.layouts.map((x) =>
              x.id === l.id
                ? {
                    ...x,
                    ...(action === "update" ? layoutSnapshot() : {}),
                    name: f.get("name"),
                  }
                : x,
            );
      await api("/layouts", "PUT", layouts);
      if (action === "delete") savedLayout = null;
      await refresh();
      render();
    },
  );
}
async function copyField(input) {
  try {
    if (navigator.clipboard && window.isSecureContext)
      await navigator.clipboard.writeText(input.value);
    else {
      const type = input.type;
      input.type = "text";
      input.focus();
      input.select();
      const ok = document.execCommand("copy");
      input.type = type;
      if (!ok) throw Error("copy");
    }
    toast("Скопировано");
  } catch {
    input.focus();
    input.select();
    toast("Нажмите Ctrl+C, чтобы скопировать выделенное поле");
  }
}
function showLinks(c) {
  const addresses = model.network.addresses || [];
  const current = location.hostname;
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(current);
  const choices = [
    { address: "127.0.0.1", label: "Этот компьютер · 127.0.0.1" },
    ...addresses.map((a) => ({
      address: a.address,
      label: "Локальная сеть · " + a.address + " (" + a.name + ")",
    })),
  ];
  if (model.network.publicHost && !choices.some((x) => x.address === model.network.publicHost))
    choices.push({
      address: model.network.publicHost,
      label: "Интернет · " + model.network.publicHost,
    });
  if (!local && !choices.some((x) => x.address === current))
    choices.push({ address: current, label: "Текущий адрес · " + current });
  const chosen = choices.some((x) => x.address === current)
    ? current
    : "127.0.0.1";
  const field = (id, label, type = "text") =>
    '<label for="' +
    id +
    '">' +
    label +
    '</label><div class="copy-row"><input id="' +
    id +
    '" readonly type="' +
    type +
    '"><button type="button" data-copy="' +
    id +
    '">Копировать</button></div>';
  modal(
    "Ссылки и доступ",
    '<p class="help">' +
      esc(c.name) +
      '</p><label>Где будут смотреть<select id="linkHost">' +
      choices
        .map(
          (x) =>
            '<option value="' +
            esc(x.address) +
            '" ' +
            (x.address === chosen ? "selected" : "") +
            ">" +
            esc(x.label) +
            "</option>",
        )
        .join("") +
      '</select></label><p id="networkHint" class="help"></p><h3 class="link-heading">В браузере</h3>' +
      field("browserUrl", "Страница просмотра") +
      '<button type="button" id="openWatch">Открыть просмотр</button><div style="text-align:center;margin:16px"><img id="qrCode" width="180" height="180" alt="QR-код для телефона"><p class="help">Наведите камеру телефона</p></div><h3 class="link-heading">В VLC и других плеерах</h3>' +
      field("rtspUrl", "RTSP") +
      field("hlsUrl", "HLS") +
      '<p class="help">VLC → Медиа → Открыть URL (Ctrl+N). Используйте свой логин <strong>' +
      esc(model.currentUser?.username || "") +
      "</strong> и пароль. Доступ можно отозвать в разделе «Пользователи».</p>",
    () => {},
    "Закрыть",
  );
  $("#dialog").className = "links-dialog";
  $("#cancel").hidden = true;
  const update = () => {
    const host = $("#linkHost").value,
      origin = location.protocol + "//" + host + ":" + model.network.port;
    $("#browserUrl").value = origin + c.watch;
    $("#qrCode").src =
      "/api/qr?text=" + encodeURIComponent($("#browserUrl").value);
    $("#hlsUrl").value = origin + c.hls;
    $("#rtspUrl").value =
      "rtsp://" + host + ":" + c.rtspPort + "/" + c.rtspPath;
    $("#networkHint").textContent =
      host === "127.0.0.1"
        ? "Эти ссылки работают только на компьютере со STREAMHUB."
        : model.network.lan
          ? "HLS и страница работают через TCP 8080, RTSP — через TCP 8554. Для интернета оба порта должны быть проброшены на роутере; безопаснее использовать VPN."
          : "Доступ по сети выключен. Включите его в настройках и перезапустите приложение через трей.";
  };
  $("#linkHost").onchange = update;
  update();
  $("#openWatch").onclick = () => {
    window.open($("#browserUrl").value, "_blank", "noopener");
  };
  document
    .querySelectorAll("[data-copy]")
    .forEach(
      (b) =>
        (b.onclick = () => copyField(document.getElementById(b.dataset.copy))),
    );
}

document.addEventListener("dragend", () => {
  dragging = false;
  document
    .querySelectorAll(".drag-over")
    .forEach((el) => el.classList.remove("drag-over"));
});
document.addEventListener("drop", () => (dragging = false));
function togglePanels() {
  document.body.classList.toggle("focus-mode");
}
function showShortcuts() {
  modal(
    "Горячие клавиши",
    '<p class="help">Enter — открыть выбранную камеру / вернуться к сетке.<br>H — скрыть / показать интерфейс.<br>F — полный экран.<br>Стрелки — выбрать соседнюю камеру.<br>Alt+1…6 — быстрые сетки 1, 4, 9, 16, 1+5, 1+7.<br>Сетки 25, 36, 49 и 64 выбираются на верхней панели.<br>Escape — вернуться к сетке и показать интерфейс.</p><p class="help">Перетащите источник слева в ячейку. Перетащите одну ячейку на другую, чтобы поменять их местами. Изменения выходного канала применяются кнопкой «Применить к каналу».</p>',
    () => {},
    "Закрыть",
  );
  $("#cancel").hidden = true;
}
$("#search").oninput = sourceList;
$("#addSource").onclick = () => addSource();
$("#focusExit").onclick = togglePanels;
document.addEventListener("keydown", (e) => {
  if (
    $("#dialog").open ||
    e.target.closest("input,select,textarea,[contenteditable=true]") ||
    view !== "wall"
  )
    return;
  if (e.key === "Escape") {
    document.body.classList.remove("focus-mode");
    if (expanded !== null) {
      expanded = null;
      render();
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.repeat) return;
  if (e.altKey && /^[1-6]$/.test(e.key)) {
    e.preventDefault();
    size = WallLayouts.sizes[+e.key - 1];
    selected = 0;
    expanded = null;
    render();
    return;
  }
  if (e.altKey) return;
  if (e.code === "KeyH") {
    e.preventDefault();
    togglePanels();
  } else if (e.code === "KeyF") {
    e.preventDefault();
    $("#fullscreen").click();
  } else if (e.key === "Enter" && !e.target.closest("button,a")) {
    e.preventDefault();
    expanded = expanded === null ? selected : null;
    render();
  } else if (
    ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
  ) {
    e.preventDefault();
    const rects = WallLayouts.rectangles(size, 1200, 1200),
      here = rects[selected],
      cx = here.x + here.w / 2,
      cy = here.y + here.h / 2,
      dx = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0,
      dy = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    const choices = rects
      .map((r, i) => ({ i, x: r.x + r.w / 2 - cx, y: r.y + r.h / 2 - cy }))
      .filter((r) => r.x * dx + r.y * dy > 0)
      .sort((a, b) => Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y));
    if (choices.length) {
      selected = choices[0].i;
      if (expanded !== null) {
        expanded = selected;
        render();
      } else {
        document
          .querySelectorAll("[data-tile]")
          .forEach((el) =>
            el.classList.toggle("selected", +el.dataset.tile === selected),
          );
        document
          .querySelector('[data-tile="' + selected + '"]')
          ?.focus({ preventScroll: true });
      }
    }
  }
});
let logoClicks = 0;
let logoClickTimer;
document.querySelector(".logo")?.addEventListener("click", () => {
  clearTimeout(logoClickTimer);
  logoClicks += 1;
  if (logoClicks < 11) {
    logoClickTimer = setTimeout(() => { logoClicks = 0; }, 5000);
    return;
  }
  logoClicks = 0;
  const overlay = document.createElement("div");
  overlay.className = "meow-overlay";
  overlay.textContent = "Мяу-Мяу";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Мяу-Мяу");
  overlay.tabIndex = -1;
  document.body.append(overlay);
  overlay.focus();
  const close = () => { clearTimeout(closeTimer); overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (event) => { if (event.key === "Escape") close(); };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  const closeTimer = setTimeout(close, 4000);
});
(async () => {
  try {
    if (desktopBootstrap) {
      history.replaceState(null, "", "/");
      await api("/login", "POST", { user: "admin", bootstrap: desktopBootstrap });
    }
    await refresh();
    slots = model.sources.slice(0, 9).map((s) => s.id);
    render();
  } catch {
    login();
  }
})();
let polling = false;
setInterval(async () => {
  if (!session || polling || document.hidden) return;
  polling = true;
  try {
    await refresh();
    if (view === "diagnostics") render();
    for (const key of activePreview) {
      const [id, fit] = key.split("|");
      await api("/sources/" + id + "/preview", "POST", { fit });
    }
  } catch (e) {
    if (!session) login();
  } finally {
    polling = false;
  }
}, 3000);
setInterval(() => {
  if (session && !document.hidden && view === "monitoring")
    $("#refreshMonitoring")?.click();
}, 15000);

// Native details keeps keyboard and touch behavior; only one action menu stays open.
document.addEventListener('toggle', event => {
  if (!event.target.matches?.('.action-menu[open]')) return;
  document.querySelectorAll('.action-menu[open]').forEach(menu => { if(menu!==event.target)menu.open=false; });
}, true);
document.addEventListener('keydown',event => {
  if(event.key==='Escape')document.querySelectorAll('.action-menu[open]').forEach(menu=>{menu.open=false;menu.querySelector('summary').focus();});
});
