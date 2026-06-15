const BASE_URL = process.env.VIBEBOARD_TEST_BASE_URL || "http://127.0.0.1:8789";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const generate = await jsonFetch("/api/generate", {
  method: "POST",
  body: JSON.stringify({
    prompt: "offline acceptance dashboard",
    modelSettings: { enabled: false },
  }),
});
assert(generate.ok === true, "/api/generate should succeed in template mode");
assert(generate.buildEvidence?.ok === true, "generate should include passing buildEvidence");
assert(generate.verificationMode === "local-simulated", "generate should expose local-simulated verificationMode");

const status = await jsonFetch("/api/status");
assert(status.mode === "offline-simulated" || status.mode === "real", "/api/status should expose mode");
assert("connected" in status, "/api/status should expose connected");

const deploy = await jsonFetch("/api/deploy", {
  method: "POST",
  body: "{}",
});
assert(deploy.ok === true, "/api/deploy should return ok response in offline mode");
assert(deploy.skipped === true, "/api/deploy should mark offline deploy as skipped");
assert(deploy.mode === "offline-simulated", "/api/deploy should expose offline-simulated mode");
assert(deploy.goldenLoop?.skipped === true, "offline deploy should include skipped goldenLoop");
assert(deploy.buildEvidence?.ok === true, "offline deploy should carry local buildEvidence");

const verify = await jsonFetch(`/api/verify?id=${encodeURIComponent(generate.id)}`);
assert(verify.ok === true, "/api/verify should return ok wrapper in offline mode");
assert(verify.skipped === true, "/api/verify should be skipped offline");
assert(verify.goldenLoop?.mode === "offline-simulated", "/api/verify should expose offline golden loop mode");

console.log(JSON.stringify({
  ok: true,
  baseUrl: BASE_URL,
  buildId: generate.id,
  statusMode: status.mode,
  deployMode: deploy.mode,
  verifyMode: verify.goldenLoop.mode,
}, null, 2));
