import {
  HARDWARE_APP_CONTRACT,
  REQUIRED_RUNTIME_APIS,
  assertFileContracts,
} from "./contracts.mjs";

export function createAppSpec(prompt, id) {
  const text = String(prompt || "").trim() || "Build a VibeBoard hardware app";
  return {
    id,
    prompt: text,
    mode: "fallback",
    title: "VibeBoard Generated App",
    subtitle: text.slice(0, 120),
    accent: "#2f6bff",
    target: "480x360 RK3566 Linux kiosk",
    hardwareApi: [...HARDWARE_APP_CONTRACT.requiredRuntimeApis],
    widgets: [
      { id: "preview", label: "Preview", value: "ready", hint: "generated screen" },
      { id: "runtime", label: "Runtime", value: "--", hint: "python result" },
      { id: "board", label: "Board", value: "--", hint: "hardware api" },
      { id: "notes", label: "Notes", value: "custom", hint: "from prompt" },
    ],
    actions: [
      { id: "primary", label: "Run" },
      { id: "secondary", label: "Mark" },
      { id: "refresh", label: "Refresh" },
    ],
  };
}

export function validateGeneratedFileContracts(files, label) {
  assertFileContracts(files, label);
}

export function injectHardwareAppContracts(source, buildId) {
  return injectHardwareAppContractsV2(source, buildId);
}

export function injectHardwareAppContractsV2(source, buildId) {
  const sourceText = String(source || "");
  const idJson = JSON.stringify(buildId);
  const runtimeApisJson = JSON.stringify(HARDWARE_APP_CONTRACT.requiredRuntimeApis);
  if (sourceText.includes("# --- VibeBoard runtime contract injection (auto-injected) ---")
    && sourceText.includes("__vb_script_content")) {
    return sourceText
      .replace(/__vb_build_id = .*$/m, `__vb_build_id = ${idJson}`)
      .replace(/result\["available_apis"\] = .*$/m, `result["available_apis"] = ${runtimeApisJson}`);
  }
  const sourceB64Json = JSON.stringify(Buffer.from(sourceText, "utf8").toString("base64"));

  return `
# --- VibeBoard runtime contract injection (auto-injected) ---
import base64 as __vb_base64
import json as __vb_json
import os as __vb_os
import socket as __vb_socket
import sys as __vb_sys

__vb_build_id = ${idJson}
__vb_script_content = __vb_base64.b64decode(${sourceB64Json}).decode("utf-8")

def __vb_parse_output(raw):
    raw = (raw or "").strip()
    if not raw:
        return {}
    try:
        return __vb_json.loads(raw)
    except Exception:
        pass
    for line in reversed([item.strip() for item in raw.splitlines() if item.strip()]):
        if line.startswith("{") or line.startswith("["):
            try:
                return __vb_json.loads(line)
            except Exception:
                pass
    return {"raw_output": raw}

def __vb_wrapped_main():
    import io
    old_stdout = __vb_sys.stdout
    __vb_sys.stdout = buffer = io.StringIO()
    try:
        try:
            exec(__vb_script_content, {"__name__": "__main__"})
        except SystemExit as exit_error:
            code = exit_error.code
            if code not in (None, 0):
                raise
    finally:
        __vb_sys.stdout = old_stdout

    result = __vb_parse_output(buffer.getvalue())
    if not isinstance(result, dict):
        result = {"value": result}
    result["build_id"] = __vb_build_id
    result["runtime"] = __vb_os.environ.get("VIBEBOARD_RUNTIME", "simulated")
    result["hostname"] = result.get("hostname") or __vb_socket.gethostname()
    result["available_apis"] = ${runtimeApisJson}
    print(__vb_json.dumps(result, ensure_ascii=False, sort_keys=True))

if __name__ == "__main__":
    __vb_wrapped_main()
`;
}

const FRONTEND_SDK_START = "/* --- VibeBoard frontend hardware SDK (auto-injected) --- */";
const FRONTEND_SDK_END = "/* --- end VibeBoard frontend hardware SDK (auto-injected) --- */";

export function injectAppHardwareSdkContracts(source, buildId) {
  const sourceText = stripInjectedFrontendHardwareSdk(String(source || ""));
  const prelude = frontendHardwareSdkBlock(buildId);
  return `${prelude}\n${sourceText.trim()}\n`;
}

function stripInjectedFrontendHardwareSdk(source) {
  const pattern = new RegExp(`${escapeRegExp(FRONTEND_SDK_START)}[\\s\\S]*?${escapeRegExp(FRONTEND_SDK_END)}\\n?`, "g");
  return String(source || "").replace(pattern, "").trim();
}

function frontendHardwareSdkBlock(buildId) {
  const buildIdJson = JSON.stringify(buildId);
  const apisJson = JSON.stringify(REQUIRED_RUNTIME_APIS);
  return `${FRONTEND_SDK_START}
;(() => {
  const BUILD_ID = ${buildIdJson};
  const REQUIRED_APIS = ${apisJson};

  const fallbackStatus = () => ({
    ok: false,
    connected: false,
    mode: "browser-fallback",
    message: "status api unavailable",
    board: null,
  });

  const fallbackProgram = () => ({
    build_id: BUILD_ID,
    runtime: "browser-fallback",
    available_apis: REQUIRED_APIS,
  });

  async function readJson(url, fallback) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(\`HTTP \${response.status}\`);
      return await response.json();
    } catch (error) {
      return { ...fallback(), ok: false, error: error.message };
    }
  }

  async function postJson(url, payload = {}) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      return response.ok ? data : { ok: false, error: data.error || \`HTTP \${response.status}\` };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  function makeSdk() {
    return Object.freeze({
      __vibeboard_system_sdk: true,
      buildId: BUILD_ID,
      requiredApis: Object.freeze([...REQUIRED_APIS]),
      async getStatus() {
        return readJson("/api/status", fallbackStatus);
      },
      async getProgramResult() {
        return readJson(\`./hardware-result.json?build_id=\${encodeURIComponent(BUILD_ID)}\`, fallbackProgram);
      },
      async getSnapshot() {
        const [status, program] = await Promise.allSettled([
          this.getStatus(),
          this.getProgramResult(),
        ]);
        return {
          build_id: BUILD_ID,
          status: status.status === "fulfilled" ? status.value : fallbackStatus(),
          program: program.status === "fulfilled" ? program.value : fallbackProgram(),
          at: new Date().toISOString(),
        };
      },
      audio: Object.freeze({
        status: () => readJson("/api/audio/status", () => ({ ok: false, mode: "unavailable" })),
        play: (payload = {}) => postJson("/api/audio/play", payload),
        record: (payload = {}) => postJson("/api/audio/record", payload),
        stop: (payload = {}) => postJson("/api/audio/stop", payload),
      }),
    });
  }

  const sdk = makeSdk();
  try {
    Object.defineProperty(window, "VibeBoardHardware", {
      get() {
        return sdk;
      },
      set(value) {
        window.__vibeboardIgnoredHardwareOverride = value;
      },
      enumerable: true,
      configurable: false,
    });
  } catch (error) {
    window.VibeBoardHardware = sdk;
  }
})();
${FRONTEND_SDK_END}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function generatedManifestV2(prompt, id, spec = createAppSpec(prompt, id), extra = {}) {
  return {
    id,
    prompt: spec.prompt || prompt,
    generator: "vibeboard-web-coding-v2",
    mode: spec.mode,
    title: spec.title,
    target: spec.target,
    hardwareApi: spec.hardwareApi,
    files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
    createdAt: new Date().toISOString(),
    ...extra,
  };
}
