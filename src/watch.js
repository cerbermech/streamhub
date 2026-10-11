"use strict";
const $ = (id) => document.getElementById(id),
  video = $("video");
const slug = location.pathname.startsWith("/channel/")
  ? location.pathname.slice(9)
  : location.pathname.startsWith("/watch/")
    ? location.pathname.slice(7)
    : null;
const legacyId = new URLSearchParams(location.search).get("id");
let player = null,
  stream = null,
  busy = false,
  retryAt = 0,
  closed = false;
function stop() {
  player?.destroy();
  player = null;
  stream = null;
  video.pause();
  video.removeAttribute("src");
  video.load();
}
function loginRequired() {
  stop();
  $("login").hidden = false;
  $("logout").hidden = true;
  video.hidden = true;
  $("hint").hidden = true;
  $("status").textContent = "Войдите, чтобы смотреть канал.";
}
function start(url) {
  stop();
  stream = url;
  retryAt = 0;
  if (window.Hls?.isSupported()) {
    player = new Hls({
      maxBufferLength: 8,
      backBufferLength: 0,
      manifestLoadingMaxRetry: 3,
    });
    player.attachMedia(video);
    player.loadSource(url);
    player.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    player.on(Hls.Events.ERROR, (_, e) => {
      if (e.fatal) {
        if (e.type === Hls.ErrorTypes?.MEDIA_ERROR) {
          player.recoverMediaError();
          return;
        }
        $("status").textContent =
          "Связь с трансляцией потеряна. Переподключение…";
        retryAt = Date.now() + 3000;
      }
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    video.play().catch(() => {});
  } else {
    $("status").textContent =
      "Этот браузер не поддерживает HLS. Откройте ссылку RTSP в VLC.";
  }
}
async function refresh() {
  if (busy || closed) return;
  busy = true;
  try {
    const r = await fetch(slug ? "/api/watch/" + encodeURIComponent(slug) : "/api/state", { signal: AbortSignal.timeout(5000) });
    if (r.status === 401) {
      loginRequired();
      return;
    }
    if (!r.ok) throw Error("server");
    const payload = await r.json();
    $("login").hidden = true;
    $("logout").hidden = false;
    const c = slug ? payload : payload.channels.find((c) => c.id === legacyId);
    if (!c) {
      stop();
      video.hidden = true;
      $("hint").hidden = true;
      $("status").textContent = "Канал не найден. Возможно, он был удалён.";
      return;
    }
    $("name").textContent = c.name;
    document.title = c.name + " — STREAMHUB";
    video.hidden = false;
    $("hint").hidden = false;
    if (!c.desired) {
      stop();
      $("status").textContent =
        "Канал остановлен. Просмотр начнётся, когда оператор запустит трансляцию.";
      return;
    }
    if (c.status !== "live") {
      $("status").textContent = payload.mediaReady
        ? "Канал подключается. Ожидание трансляции…"
        : "Видеосервер недоступен. Ожидание восстановления…";
      if (stream) stop();
      return;
    }
    if (stream !== c.hls || (retryAt && Date.now() >= retryAt)) {
      start(c.hls);
      $("status").textContent = "Подключение к трансляции…";
    } else if (video.readyState >= 3 && !video.paused)
      $("status").textContent = "● В эфире";
  } catch {
    $("status").textContent = "Нет связи с сервером. Повторяем подключение…";
  } finally {
    busy = false;
  }
}
video.onplaying = () => {
  $("status").textContent = "● В эфире";
  retryAt = 0;
};
video.onwaiting = () => {
  $("status").textContent = "Буферизация…";
};
video.onerror = () => {
  retryAt = Date.now() + 3000;
};
$("show").onclick = () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("show").textContent = show ? "Скрыть" : "Показать";
  $("show").setAttribute("aria-pressed", String(show));
};
$("login").onsubmit = async (e) => {
  e.preventDefault();
  $("submit").disabled = true;
  $("error").textContent = "";
  try {
    const r = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user: $("user").value,
        password: $("password").value,
      }),
    });
    if (!r.ok) {
      const b = await r.json();
      throw Error(b.error || "Не удалось войти");
    }
    $("password").value = "";
    await refresh();
  } catch (e) {
    $("error").textContent = e.message;
  } finally {
    $("submit").disabled = false;
  }
};
$("logout").onclick = async () => {
  try {
    await fetch("/api/logout", { method: "POST" });
    loginRequired();
  } catch {
    $("status").textContent = "Нет связи с сервером";
  }
};
const timer = setInterval(refresh, 3000);
window.addEventListener("pagehide", () => {
  closed = true;
  clearInterval(timer);
  stop();
});
refresh();
