"use strict";
const $ = (x) => document.getElementById(x);
async function load() {
  const r = await fetch("/api/state");
  if (r.status === 401) {
    $("login").hidden = false;
    $("channels").innerHTML = "";
    return;
  }
  const s = await r.json();
  $("login").hidden = true;
  $("channels").innerHTML =
    "<h1>Доступные каналы</h1>" +
    (s.channels
      .map(
        (c) =>
          `<a class="card" href="${c.watch}"><b>${c.name.replace(/[<&]/g, (x) => (x === "<" ? "&lt;" : "&amp;"))}</b><br><small class="${c.status === "live" ? "live" : ""}">${c.status === "live" ? "● В эфире" : "Не в эфире"}</small></a>`,
      )
      .join("") || "<p>Вам пока не назначили каналы.</p>");
}
$("login").onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user: $("user").value,
      password: $("password").value,
    }),
  });
  if (!r.ok) {
    $("error").textContent = (await r.json()).error;
    return;
  }
  $("password").value = "";
  load();
};
load();
