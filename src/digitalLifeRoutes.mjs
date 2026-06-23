import { handleDigitalLifeRequest } from "./digitalLife.mjs";
import {
  digitalLifeListenStart,
  digitalLifeListenStop,
  digitalLifeSay,
  getDigitalLifeHardware,
} from "./digitalLifeHardware.mjs";

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function createDigitalLifeRuntime(store, options = {}) {
  const env = options.env || process.env;
  const appendLog = options.appendLog || (() => {});
  const intervalMs = positiveInt(env.DIGITAL_LIFE_LOOP_MS, 30000);
  const runtime = {
    enabled: env.DIGITAL_LIFE_AUTOSTART !== "0",
    running: false,
    intervalMs,
    timer: null,
    lastTickAt: "",
    lastAction: null,
    lastError: "",
  };

  function snapshot() {
    const { timer, ...publicRuntime } = runtime;
    return publicRuntime;
  }

  function runTick(reason = "runtime") {
    if (!runtime.enabled || runtime.running) return snapshot();
    runtime.running = true;
    try {
      const result = store.tick({ source: reason, loop_enabled: true });
      runtime.lastTickAt = new Date().toISOString();
      runtime.lastAction = result.action || null;
      runtime.lastError = "";
      return { ...snapshot(), result };
    } catch (error) {
      runtime.lastError = error?.message || String(error);
      Promise.resolve(appendLog("digital_life.loop.failed", { error: runtime.lastError })).catch(() => {});
      return snapshot();
    } finally {
      runtime.running = false;
    }
  }

  function start() {
    runtime.enabled = true;
    if (!runtime.timer) {
      runtime.timer = setInterval(() => runTick("runtime"), runtime.intervalMs);
      if (typeof runtime.timer.unref === "function") runtime.timer.unref();
      setTimeout(() => runTick("startup"), 1000).unref?.();
    }
    store.updateState({ loop_enabled: true });
    return snapshot();
  }

  function stop() {
    runtime.enabled = false;
    if (runtime.timer) {
      clearInterval(runtime.timer);
      runtime.timer = null;
    }
    store.updateState({ loop_enabled: false });
    return snapshot();
  }

  function configure(patch = {}) {
    if (patch.enabled === true) return start();
    if (patch.enabled === false) return stop();
    return snapshot();
  }

  if (runtime.enabled) start();

  return {
    start,
    stop,
    configure,
    tick: runTick,
    snapshot,
  };
}

export function createDigitalLifeRoutes({ store, readBody, json, appendLog, env } = {}) {
  if (!store) throw new Error("createDigitalLifeRoutes requires store");
  if (typeof readBody !== "function") throw new Error("createDigitalLifeRoutes requires readBody");
  if (typeof json !== "function") throw new Error("createDigitalLifeRoutes requires json");

  const runtime = createDigitalLifeRuntime(store, { appendLog, env });

  async function handle(req, res, url) {
    if (await handleDigitalLifeRequest({ req, res, url, readBody, json, store })) {
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/digital-life/runtime") {
      json(res, 200, { ok: true, runtime: runtime.snapshot() });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/runtime") {
      const body = await readBody(req);
      json(res, 200, { ok: true, runtime: runtime.configure(body || {}) });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/api/digital-life/hardware") {
      json(res, 200, await getDigitalLifeHardware());
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/say") {
      const body = await readBody(req);
      json(res, 200, await digitalLifeSay(body || {}));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/listen/start") {
      const body = await readBody(req);
      json(res, 200, await digitalLifeListenStart(body || {}));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/api/digital-life/listen/stop") {
      await readBody(req).catch(() => ({}));
      json(res, 200, await digitalLifeListenStop());
      return true;
    }

    return false;
  }

  return { handle, runtime };
}
