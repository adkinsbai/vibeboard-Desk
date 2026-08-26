import { classifyError } from "../src/errorClassifier.mjs";
import { MODEL_PROVIDERS, normalizeModelSettings } from "../src/modelSettings.mjs";
import http from "node:http";
import { withServer } from "./support/serverHarness.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

{
  assert(MODEL_PROVIDERS.glm, "GLM provider preset should exist");
  const settings = normalizeModelSettings({
    provider: "glm",
    apiKey: "synthetic-test-key",
  });
  assert(settings.provider === "glm", `expected provider glm, got ${settings.provider}`);
  assert(settings.providerLabel === "GLM 5.2", `expected GLM 5.2 label, got ${settings.providerLabel}`);
  assert(settings.baseUrl === "https://maas-openapi.wanjiedata.com/api/v1", `unexpected GLM baseUrl: ${settings.baseUrl}`);
  assert(settings.model === "glm-5.2", `unexpected GLM model: ${settings.model}`);
  assert(settings.enabled === true, "GLM settings should be enabled when apiKey is present");
}

{
  const classified = classifyError(new Error("LLM_CALL_FAILED: HTTP 402; provider=余额不足，请充值后重试"));
  assert(classified.errorType === "llm_quota", `expected llm_quota, got ${JSON.stringify(classified)}`);
  assert(classified.statusCode === 502, `quota provider failures should be surfaced as gateway errors, got ${classified.statusCode}`);
  assert(classified.nextActions.some(action => /余额|credit|balance|quota|充值/i.test(action)), `quota next actions should be actionable: ${classified.nextActions.join(", ")}`);
}

{
  const classified = classifyError({
    type: "llm_failed",
    status: 402,
    providerMessage: "余额不足，请充值后重试",
    message: "LLM_CALL_FAILED: HTTP 402; provider=余额不足，请充值后重试",
  });
  assert(classified.errorType === "llm_quota", `expected explicit llm_failed quota to be refined, got ${JSON.stringify(classified)}`);
}

{
  const modelServer = http.createServer((req, res) => {
    if (req.url?.includes("/chat/completions")) {
      res.writeHead(402, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "余额不足，请充值后重试" } }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  const modelBaseUrl = await listen(modelServer);
  try {
    await withServer(async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/api/clarify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          prompt: "做一个天气小屏",
          modelSettings: {
            provider: "glm",
            baseUrl: modelBaseUrl,
            model: "glm-5.2",
            apiKey: "synthetic-test-key",
          },
        }),
      });
      const data = await response.json();
      assert([402, 502].includes(response.status), `expected HTTP 402/502 for quota failure, got ${response.status}: ${JSON.stringify(data)}`);
      assert(data.errorType === "llm_quota", `expected llm_quota route response, got ${JSON.stringify(data)}`);
      assert(/充值|余额|额度/.test(data.suggestion || ""), `expected actionable quota suggestion, got ${JSON.stringify(data)}`);
    }, { wait: { path: "/api/health" }, dbPrefix: "vibeboard-model-provider-errors" });
  } finally {
    await close(modelServer);
  }
}

{
  let receivedAuthorization = "";
  const modelServer = http.createServer((req, res) => {
    if (req.url?.includes("/chat/completions")) {
      receivedAuthorization = String(req.headers.authorization || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ skip: true }) } }],
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  const modelBaseUrl = await listen(modelServer);
  try {
    await withServer(async ({ baseUrl }) => {
      const register = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "+15551234567", password: "correct-horse-42" }),
      });
      assert(register.ok, `public test user registration should succeed, got ${register.status}`);
      const cookie = String(register.headers.get("set-cookie") || "").split(";", 1)[0];
      assert(cookie, "public test user registration should set a session cookie");

      const response = await fetch(`${baseUrl}/api/clarify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
          cookie,
        },
        body: JSON.stringify({
          prompt: "Build a weather screen",
          modelSettings: {
            provider: "custom",
            baseUrl: modelBaseUrl,
            model: "browser-only-model",
            apiKey: "browser-only-test-key",
          },
        }),
      });
      assert(response.ok, `public model configuration should reach the provider, got ${response.status}: ${await response.text()}`);
      assert(
        receivedAuthorization === "Bearer browser-only-test-key",
        "public deployment should forward the browser-only API key to the configured provider"
      );

      const jobResponse = await fetch(`${baseUrl}/api/jobs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          accept: "application/json",
          cookie,
        },
        body: JSON.stringify({
          type: "agent",
          payload: {
            action: "message",
            messages: [{ role: "user", content: "Plan a weather screen" }],
            modelSettings: {
              provider: "custom",
              baseUrl: modelBaseUrl,
              model: "browser-only-model",
              apiKey: "browser-only-test-key",
            },
          },
        }),
      });
      const jobData = await jobResponse.json();
      assert(jobResponse.ok, `public agent job should complete, got ${jobResponse.status}: ${JSON.stringify(jobData)}`);
      assert(
        !Object.hasOwn(jobData.job?.input?.modelSettings || {}, "apiKey"),
        "public job records must not persist browser API keys"
      );
    }, {
      wait: { path: "/api/health" },
      dbPrefix: "vibeboard-public-model-settings",
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
  } finally {
    await close(modelServer);
  }
}

console.log("model provider and quota error classification ok");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}
