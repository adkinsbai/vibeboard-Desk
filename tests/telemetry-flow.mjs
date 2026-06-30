import { assert, withServer } from "./support/serverHarness.mjs";

const ADMIN_PHONE = "+15550001111";
const USER_PHONE = "+15550002222";
const PASSWORD = "correct-horse-42";

await withServer(async ({ baseUrl }) => {
  const adminCookie = await register(baseUrl, ADMIN_PHONE, PASSWORD);
  const userCookie = await register(baseUrl, USER_PHONE, PASSWORD);

  const event = await postJson(baseUrl, "/api/telemetry", {
    event_type: "agent.debug",
    category: "agent",
    action: "compile",
    page: "/workbench",
    board_id: "szpi-esp32s3",
    conversation_id: "conversation-raw-id",
    session_id: "session-raw-id",
    payload: {
      prompt: "用户想做一个 LVGL WiFi 页面",
      prompt_excerpt: "用户想做一个 LVGL WiFi 页面",
      password: "should-not-store",
      api_key: "sk-should-not-store",
      databaseUrl: "postgresql://user:secret@example.com/db",
      nested: {
        authorization: "Bearer should-not-store",
      },
    },
  }, userCookie);
  assert(event.ok === true, "telemetry post should succeed");

  const telemetry = await getJson(baseUrl, "/api/admin/telemetry", adminCookie);
  const found = (telemetry.events || []).find(row => row.event_type === "agent.debug");
  assert(found, "admin should see telemetry event");
  assert(found.user_hash && !found.user_hash.includes(USER_PHONE), "telemetry should use anonymized user hash");
  assert(found.session_hash && !found.session_hash.includes("session-raw-id"), "telemetry should hash session id");
  assert(found.conversation_hash && !found.conversation_hash.includes("conversation-raw-id"), "telemetry should hash conversation id");
  const serialized = JSON.stringify(found);
  assert(!serialized.includes(USER_PHONE), "telemetry should not expose raw phone");
  assert(!serialized.includes("should-not-store"), "telemetry should redact secrets");
  assert(!serialized.includes("postgresql://"), "telemetry should redact database URLs");
  assert(serialized.includes("[redacted]"), "telemetry payload should show redaction markers");
  assert(found.category === "agent" && found.action === "compile", "telemetry should keep behavior classification");
  assert(found.board_id === "szpi-esp32s3", "telemetry should keep board preference");
}, {
  dbPrefix: "telemetry-flow",
  env: {
    VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
    VIBEBOARD_ADMIN_PHONES: ADMIN_PHONE,
  },
  wait: { path: "/api/health" },
});

console.log("telemetry flow ok");

async function register(baseUrl, phone, password) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert(response.ok, `register ${phone} should succeed`);
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function postJson(baseUrl, path, payload, cookie = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} should return ok, got HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

async function getJson(baseUrl, path, cookie = "") {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  const data = await response.json().catch(() => ({}));
  assert(response.ok, `${path} should return ok, got HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}
