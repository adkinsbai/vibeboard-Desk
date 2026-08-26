import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl }) => {
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+15550001111", password: "no-template-test-42" }),
  });
  assert(register.ok, `test account registration should succeed, got ${register.status}`);
  const cookie = String(register.headers.get("set-cookie") || "").split(";", 1)[0];
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", accept: "application/json", cookie },
    body: JSON.stringify({ prompt: "Build a task-specific hardware app", modelSettings: { enabled: false } }),
  });
  const data = await response.json();
  assert(response.status === 400, `missing model config should fail clearly, got ${response.status}: ${JSON.stringify(data)}`);
  assert(data.errorType === "missing_model_config", `expected missing_model_config, got ${JSON.stringify(data)}`);
  assert(!data.id && !data.files, "missing model config must not return a generated artifact");

  const oldPreview = await fetch(`${baseUrl}/generated/current/manifest.json`, { cache: "no-store" });
  assert(oldPreview.status === 404, `fresh server must not bootstrap generated/current, got ${oldPreview.status}`);
}, {
  dbPrefix: "no-template-generation",
  wait: { path: "/api/health" },
  env: {
    VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
    VIBEBOARD_BILLING_MODE: "free",
    VIBEBOARD_REQUIRE_PHONE_VERIFICATION: "0",
    VIBEBOARD_LLM_PROVIDER: "",
    VIBEBOARD_LLM_BASE_URL: "",
    VIBEBOARD_LLM_MODEL: "",
    VIBEBOARD_LLM_API_KEY: "",
  },
});

console.log("public generation never falls back to a bootstrap template");
