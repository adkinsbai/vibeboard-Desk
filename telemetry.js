(function () {
  const STORAGE_KEY = "vibeboard-telemetry-session";
  const MAX_TEXT = 240;

  function sessionId() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) return saved;
      const id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(STORAGE_KEY, id);
      return id;
    } catch {
      return "";
    }
  }

  function redact(value) {
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return value.replace(/(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+|postgres(?:ql)?:\/\/[^\s"'`]+)/gi, "[redacted]").slice(0, 1600);
    if (Array.isArray(value)) return value.slice(0, 20).map(redact);
    if (typeof value === "object") {
      return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => (
        /password|token|secret|api[_-]?key|authorization|cookie/i.test(key)
          ? [key, "[redacted]"]
          : [key, redact(item)]
      )));
    }
    return String(value).slice(0, 1600);
  }

  function track(eventType, detail) {
    const payload = {
      event_type: eventType,
      session_id: sessionId(),
      page: location.pathname,
      payload: redact({
        href: location.href,
        title: document.title,
        ...detail,
      }),
    };
    try {
      fetch("/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch {}
  }

  window.VibeTelemetry = { track };

  document.addEventListener("click", event => {
    const target = event.target?.closest?.("button,a,[data-telemetry]");
    if (!target) return;
    const label = target.getAttribute("data-telemetry")
      || target.getAttribute("aria-label")
      || target.id
      || target.textContent;
    track("ui.click", {
      category: "ui",
      action: target.id || target.tagName.toLowerCase(),
      label: String(label || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT),
    });
  }, { passive: true });

  window.addEventListener("error", event => {
    track("client.error", {
      category: "error",
      severity: "error",
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener("unhandledrejection", event => {
    track("client.unhandledrejection", {
      category: "error",
      severity: "error",
      reason: event.reason?.message || String(event.reason || ""),
      stack: event.reason?.stack || "",
    });
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => track("page.view", { category: "page" }), { once: true });
  } else {
    track("page.view", { category: "page" });
  }
})();
