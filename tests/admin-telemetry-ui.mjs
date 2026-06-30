import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

const ADMIN_PHONE = "+15550101010";
const PASSWORD = "correct-horse-42";

await withServer(async ({ baseUrl }) => {
  const cookie = await register(baseUrl, ADMIN_PHONE, PASSWORD);
  await postTelemetry(baseUrl, cookie, {
    event_type: "agent.request",
    category: "agent",
    action: "confirm_build",
    page: "/workbench",
    board_id: "taishan-gray",
    session_id: "admin-ui-session",
    payload: {
      category: "agent",
      action: "confirm_build",
      board_id: "taishan-gray",
      prompt_excerpt: "做一个天气和设备状态小屏",
    },
  });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  try {
    await page.goto(`${baseUrl}/admin.html`, { waitUntil: "domcontentloaded" });
    await page.context().addCookies([cookieToPlaywright(cookie, baseUrl)]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("#telemetryInsights").waitFor({ timeout: 6000 });
    const text = await page.locator("#telemetryInsights").textContent();
    assert(text.includes("taishan-gray"), "admin telemetry insights should show board preference");
    assert(text.includes("agent:confirm_build"), "admin telemetry insights should show behavior classification");
    assert(text.includes("做一个天气和设备状态小屏"), "admin telemetry insights should show recent task summaries");
  } finally {
    await browser.close();
  }
}, {
  dbPrefix: "admin-telemetry-ui",
  env: {
    VIBEBOARD_PUBLIC_DEPLOYMENT: "1",
    VIBEBOARD_ADMIN_PHONES: ADMIN_PHONE,
  },
  wait: { path: "/api/health" },
});

console.log("admin telemetry ui ok");

async function register(baseUrl, phone, password) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password }),
  });
  assert(response.ok, "admin registration should succeed");
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function postTelemetry(baseUrl, cookie, payload) {
  const response = await fetch(`${baseUrl}/api/telemetry`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
    },
    body: JSON.stringify(payload),
  });
  assert(response.ok, "telemetry seed should succeed");
}

function cookieToPlaywright(cookie, baseUrl) {
  const [name, value] = String(cookie || "").split("=");
  return {
    name,
    value,
    url: baseUrl,
    httpOnly: true,
    sameSite: "Lax",
  };
}
