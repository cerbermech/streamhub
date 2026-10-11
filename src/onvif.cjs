"use strict";

const { Cam, Discovery } = require("onvif/promises");

const cleanError = (error) =>
  String(error?.message || error || "Ошибка ONVIF")
    .replace(/(?:rtsp|https?):\/\/\S+/gi, "[адрес камеры]")
    .slice(0, 500);

class OnvifManager {
  constructor() {
    this.clients = new Map();
  }

  async discover(timeout = 4500) {
    let cameras;
    try {
      cameras = await Discovery.probe({ timeout, resolve: true });
    } catch (error) {
      if (!Array.isArray(error)) throw Error(cleanError(error));
      cameras = [];
    }
    const unique = new Map();
    for (const camera of cameras || []) {
      const xaddr = camera.xaddrs?.[0];
      const host = camera.hostname || xaddr?.hostname;
      if (!host) continue;
      unique.set(host + ":" + (camera.port || xaddr?.port || 80), {
        host,
        port: Number(camera.port || xaddr?.port || 80),
        path: camera.path || xaddr?.pathname || "/onvif/device_service",
        urn: camera.urn || "",
      });
    }
    return [...unique.values()];
  }

  async connect(config, fresh = false) {
    const key = `${config.host}:${config.port || 80}:${config.username || ""}`;
    if (!fresh && this.clients.has(key)) return this.clients.get(key);
    const camera = new Cam({
      hostname: config.host,
      port: Number(config.port || 80),
      path: config.path || "/onvif/device_service",
      username: config.username || "",
      password: config.password || "",
      timeout: 8000,
    });
    try {
      await camera.connect();
    } catch (error) {
      throw Error("Не удалось подключиться к ONVIF: " + cleanError(error));
    }
    this.clients.set(key, camera);
    return camera;
  }

  async inspect(config) {
    const camera = await this.connect(config, true);
    const info = await camera.getDeviceInformation().catch(() => camera.deviceInformation || {});
    const stream = await camera.getStreamUri({ protocol: "RTSP" }).catch(() => null);
    const ptz = !!camera.uri?.ptz || !!camera.capabilities?.PTZ || !!camera.capabilities?.ptz;
    let presets = {};
    if (ptz) presets = await camera.getPresets().catch(() => camera.presets || {});
    return {
      manufacturer: info?.manufacturer || "",
      model: info?.model || "",
      firmware: info?.firmwareVersion || "",
      serialNumber: info?.serialNumber || "",
      hardwareId: info?.hardwareId || "",
      streamUri: stream?.uri || stream || "",
      ptz,
      presets: Object.entries(presets || {}).map(([token, value]) => ({
        token,
        name: typeof value === "string" ? value : value?.name || token,
      })),
      profiles: (camera.profiles || []).map((profile) => ({
        token: profile.$?.token || profile.token || "",
        name: profile.name || "Профиль",
        resolution: profile.videoEncoderConfiguration?.resolution || null,
      })),
    };
  }

  async command(config, input) {
    const camera = await this.connect(config);
    const speed = Math.max(0.05, Math.min(1, Number(input.speed || 0.45)));
    switch (input.action) {
      case "pulse": {
        const duration = Math.max(180, Math.min(2000, Number(input.duration || 320)));
        const x = Math.max(-1, Math.min(1, Number(input.x || 0))) * speed;
        const y = Math.max(-1, Math.min(1, Number(input.y || 0))) * speed;
        const zoom = Math.max(-1, Math.min(1, Number(input.zoom || 0))) * speed;
        const move = { x, y, zoom, timeout: duration + 500 };
        if (zoom && !x && !y) move.onlySendZoom = true;
        else if (!zoom) move.onlySendPanTilt = true;
        await camera.continuousMove(move);
        await new Promise((resolve) => setTimeout(resolve, duration));
        await camera.stop({ panTilt: true, zoom: true });
        return { ok: true };
      }
      case "move":
        await camera.continuousMove({
          x: Math.max(-1, Math.min(1, Number(input.x || 0))) * speed,
          y: Math.max(-1, Math.min(1, Number(input.y || 0))) * speed,
          zoom: Math.max(-1, Math.min(1, Number(input.zoom || 0))) * speed,
          timeout: 800,
        });
        return { ok: true };
      case "stop":
        await camera.stop({ panTilt: true, zoom: true });
        return { ok: true };
      case "home":
        await camera.gotoHomePosition({});
        return { ok: true };
      case "preset":
        if (!input.token) throw Error("Не выбран пресет");
        await camera.gotoPreset({ preset: input.token });
        return { ok: true };
      case "savePreset": {
        const name = String(input.name || "").trim();
        if (!name || name.length > 40) throw Error("Название пресета: от 1 до 40 символов");
        const token = await camera.setPreset({ presetName: name });
        return { ok: true, token };
      }
      case "removePreset":
        if (!input.token) throw Error("Не выбран пресет");
        await camera.removePreset({ presetToken: input.token });
        return { ok: true };
      case "reboot":
        await camera.systemReboot();
        this.clients.clear();
        return { ok: true };
      case "syncTime":
        await camera.setSystemDateAndTime({ dateTimeType: "Manual", daylightSavings: false, dateTime: new Date() });
        return { ok: true };
      default:
        throw Error("Неизвестная команда ONVIF");
    }
  }
}

module.exports = { OnvifManager, cleanError };
