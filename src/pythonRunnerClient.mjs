const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RUNNER_FILE_BYTES = 512 * 1024;

export function resolvePythonRunnerConfig(options = {}) {
  const url = normalizeRunnerUrl(options.pythonRunnerUrl || process.env.PYTHON_RUNNER_URL);
  if (!url) return null;
  return {
    url,
    token: String(options.pythonRunnerToken ?? process.env.PYTHON_RUNNER_TOKEN ?? ""),
    timeoutMs: positiveInt(options.pythonRunnerTimeoutMs, positiveInt(process.env.PYTHON_RUNNER_TIMEOUT_MS, positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS))),
    required: boolish(options.pythonRunnerRequired ?? process.env.PYTHON_RUNNER_REQUIRED),
  };
}

export async function executePythonRunner(files = {}, options = {}) {
  const config = resolvePythonRunnerConfig(options);
  if (!config) return null;

  const endpoint = runnerEndpoint(config.url, "/v1/python/execute");
  const timeoutMs = positiveInt(options.timeoutMs, config.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs + 1000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({
        mode: options.mode || "run",
        entry: options.entry || "hardware_app.py",
        timeoutMs,
        files: serializeRunnerFiles(files),
      }),
      signal: controller.signal,
    });

    const text = await response.text();
    const payload = parseJson(text);
    if (!response.ok) {
      return runnerResult({
        ok: false,
        mode: options.mode,
        entry: options.entry,
        transportError: true,
        statusCode: response.status,
        message: payload?.error || payload?.message || text || `Python runner returned HTTP ${response.status}.`,
      });
    }

    return runnerResult({
      ok: Boolean(payload?.ok),
      mode: payload?.mode || options.mode,
      entry: payload?.entry || options.entry,
      stdout: payload?.stdout,
      stderr: payload?.stderr,
      exitCode: payload?.exitCode,
      files: payload?.files,
      message: payload?.error || payload?.message,
      statusCode: response.status,
    });
  } catch (error) {
    return runnerResult({
      ok: false,
      mode: options.mode,
      entry: options.entry,
      transportError: true,
      message: error?.name === "AbortError"
        ? `Python runner timed out after ${timeoutMs}ms.`
        : error?.message || "Python runner request failed.",
    });
  } finally {
    clearTimeout(timer);
  }
}

export function isPythonRunnerTransportError(result) {
  return Boolean(result?.transportError);
}

export function pythonRunnerRequired(options = {}) {
  return Boolean(resolvePythonRunnerConfig(options)?.required);
}

function runnerResult({
  ok,
  mode = "run",
  entry = "hardware_app.py",
  stdout = "",
  stderr = "",
  exitCode = ok ? 0 : 1,
  files = {},
  message = "",
  transportError = false,
  statusCode = null,
} = {}) {
  return {
    ok: Boolean(ok),
    command: `python-runner:${mode || "run"}`,
    args: [entry || "hardware_app.py"],
    stdout: String(stdout || ""),
    stderr: String(stderr || ""),
    exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : (ok ? 0 : 1),
    message: String(message || ""),
    files: files && typeof files === "object" ? files : {},
    runner: true,
    transportError: Boolean(transportError),
    statusCode,
  };
}

function serializeRunnerFiles(files = {}) {
  const output = {};
  for (const [name, value] of Object.entries(files || {})) {
    if (!isSafeRunnerPath(name)) continue;
    if (typeof value === "string") {
      output[name] = value.slice(0, MAX_RUNNER_FILE_BYTES);
    } else if (Buffer.isBuffer(value)) {
      output[name] = {
        encoding: "base64",
        data: value.subarray(0, MAX_RUNNER_FILE_BYTES).toString("base64"),
      };
    }
  }
  return output;
}

function isSafeRunnerPath(name) {
  const value = String(name || "").replace(/\\/g, "/");
  return value
    && !value.startsWith("/")
    && !value.includes("../")
    && !value.includes("\0");
}

function normalizeRunnerUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function runnerEndpoint(baseUrl, route) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  const routePath = String(route || "").replace(/^\/+/, "");
  url.pathname = `${basePath}/${routePath}`;
  url.search = "";
  url.hash = "";
  return url;
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return null;
  }
}

function positiveInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function boolish(value) {
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|required)$/i.test(String(value || "").trim());
}
