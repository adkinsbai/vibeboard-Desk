import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl }) => {
  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      prompt: "build a small calendar screen",
      modelSettings: { enabled: false },
    }),
  });
  const body = await response.json();

  assert(response.status === 400, `missing model should fail before generation, got HTTP ${response.status}`);
  assert(body.ok === false, "missing model response should be ok:false");
  assert(body.errorType === "no_api_key", `missing model should be classified as no_api_key: ${JSON.stringify(body)}`);
  assert(!("source" in body), "missing model response must not return a generated source");
  assert(!JSON.stringify(body).includes("template"), "missing model response must not mention or expose a template fallback");
});

await withServer(async ({ baseUrl }) => {
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phone: "+15550009999",
      password: "correct-horse-42",
    }),
  });
  const cookie = String(register.headers.get("set-cookie") || "").split(";")[0];
  assert(register.status === 200 && cookie, "public regression user should be able to register");

  const response = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      cookie,
    },
    body: JSON.stringify({
      prompt: "build a small calendar screen",
      modelSettings: { enabled: false },
    }),
  });
  const body = await response.json();

  assert(response.status === 400, `public deployment without a model should fail, got HTTP ${response.status}`);
  assert(body.errorType === "no_api_key", `public deployment must preserve no_api_key: ${JSON.stringify(body)}`);
  assert(!("source" in body), "public deployment must not silently return generated files");
  assert(!JSON.stringify(body).includes("template"), "public deployment must not expose a template fallback");
}, {
  env: {
    VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
    VIBEBOARD_REQUIRE_PHONE_VERIFICATION: "0",
  },
  wait: { path: "/api/health" },
});

console.log(JSON.stringify({ ok: true, case: "no-forced-template" }, null, 2));
