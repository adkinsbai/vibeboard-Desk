import { assert, withServer } from "./support/serverHarness.mjs";

const PHONE = "+15551234567";
const USER_PHONE = "+15557654321";
const PASSWORD = "correct-horse-42";

function stubModelSettings(baseUrl) {
  return {
    provider: "custom",
    baseUrl,
    model: "stub-model",
  };
}

await withServer(async ({ baseUrl }) => {
  const unauthenticated = await raw(baseUrl, "/api/conversations");
  assert(unauthenticated.status === 401, "public deployment should require login for conversations");

  const register = await raw(baseUrl, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phone: PHONE,
      password: PASSWORD,
    }),
  });
  assert(register.status === 200, "register should succeed");
  assert(register.data.user?.role === "admin", "configured admin phone should register as admin");
  const cookie = cookieFrom(register.response);
  assert(cookie, "register should set a session cookie");

  const me = await getJson(baseUrl, "/api/me", cookie);
  assert(me.user?.phone === PHONE, "session should return the registered user");
  assert(Number(me.credits?.credits_balance) === 0, "public beta accounts should start with zero credits while usage is free");
  assert(me.usage?.billing_mode === "free", "public beta should report free usage mode");

  const conversation = await postJson(baseUrl, "/api/conversations", { title: "Public Auth Test" }, cookie);
  assert(conversation.id, "authenticated user should be able to create a conversation");
  const listedConversations = await getJson(baseUrl, "/api/conversations", cookie);
  assert(listedConversations.conversations?.some(item => item.id === conversation.id), "created conversation should remain listed after creation");

  const users = await getJson(baseUrl, "/api/admin/users", cookie);
  assert(users.users?.some(user => user.phone === PHONE), "admin should list registered users");

  const credits = await getJson(baseUrl, "/api/credits", cookie);
  assert(credits.billingMode === "free", "credits endpoint should report free billing mode");

  const regularCookie = await registerUser(baseUrl, USER_PHONE, PASSWORD);
  const regularMe = await getJson(baseUrl, "/api/me", regularCookie);
  assert(regularMe.user?.role === "user", "non-admin phone should register as a regular user");

  const blockedAdmin = await raw(baseUrl, "/api/admin/users", {
    headers: { cookie: regularCookie },
  });
  assert(blockedAdmin.status === 403, "regular users should not access admin user list");

  const blockedStatus = await raw(baseUrl, "/api/status", {
    headers: { cookie: regularCookie },
  });
  assert(blockedStatus.status === 403, "regular users should not access hardware status in public deployment");

  const hiddenDigitalLife = await raw(baseUrl, "/digital-life.html", {
    headers: { accept: "text/html", cookie: regularCookie },
  });
  assert(hiddenDigitalLife.status === 404, "public deployment should not expose the Digital Life page");

  const hiddenDigitalLifeApi = await raw(baseUrl, "/api/digital-life/state", {
    headers: { cookie: regularCookie },
  });
  assert(hiddenDigitalLifeApi.status === 404, "public deployment should not expose Digital Life APIs");

  const acceptedJob = await raw(baseUrl, "/api/jobs", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify({
      type: "generate",
      payload: {
        prompt: "should not start",
        conversation_id: conversation.id,
        modelSettings: stubModelSettings(baseUrl),
      },
    }),
  });
  assert(acceptedJob.status === 200, `public /api/jobs should run request-bound jobs, got ${acceptedJob.status}`);
  assert(acceptedJob.data.job?.status === "succeeded", `public /api/jobs should return a final job, got ${JSON.stringify(acceptedJob.data.job)}`);
  assert(acceptedJob.data.job?.output?.ok === true, "free public beta should allow AI jobs even with zero credits");
  assert(acceptedJob.data.job?.input?.max_iterations === 12, "public jobs should allow enough agent iterations by default");
  assert(acceptedJob.data.job?.input?.repair_attempts === 2, "public jobs should keep two auto-repair attempts by default");
  const persistedJob = await getJson(baseUrl, `/api/jobs/${encodeURIComponent(acceptedJob.data.job.id)}`, cookie);
  assert(persistedJob.job?.status === "succeeded", "request-bound public job should persist its final status");
}, {
  dbPrefix: "auth-flow",
  env: {
    VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
    VIBEBOARD_BILLING_MODE: "free",
    VIBEBOARD_REQUIRE_PHONE_VERIFICATION: "0",
    VIBEBOARD_ADMIN_PHONES: PHONE,
    VIBEBOARD_LLM_PROVIDER: "custom",
    VIBEBOARD_LLM_API_KEY: "test-key",
    RENDER_RUNNER_REQUIRED: "false",
  },
  wait: { path: "/api/health" },
});

console.log("auth flow ok");

async function registerUser(baseUrl, phone, password) {
  const registered = await raw(baseUrl, "/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      phone,
      password,
    }),
  });
  assert(registered.response.ok, `register ${phone} should succeed`);
  const cookie = cookieFrom(registered.response);
  assert(cookie, `register ${phone} should set a session cookie`);
  return cookie;
}

async function postJson(baseUrl, path, payload, cookie = "") {
  const result = await raw(baseUrl, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(payload),
  });
  assert(result.response.ok, `${path} should return ok HTTP, got ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function getJson(baseUrl, path, cookie = "") {
  const result = await raw(baseUrl, path, {
    headers: cookie ? { cookie } : {},
  });
  assert(result.response.ok, `${path} should return ok HTTP, got ${result.status}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function raw(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      accept: "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { response, status: response.status, data };
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}
