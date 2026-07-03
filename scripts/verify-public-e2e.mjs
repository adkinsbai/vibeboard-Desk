import { randomUUID } from "node:crypto";

const BASE_URL = String(process.env.VIBEBOARD_PUBLIC_E2E_URL || process.env.VIBEBOARD_TEST_BASE_URL || "https://vibeboard-chi.vercel.app").replace(/\/+$/, "");
const PASSWORD = process.env.VIBEBOARD_PUBLIC_E2E_PASSWORD || "correct-horse-42";
const PHONE = process.env.VIBEBOARD_PUBLIC_E2E_PHONE || `+1555${String(Math.floor(Math.random() * 1000000)).padStart(6, "0")}`;
const TIMEOUT_MS = Number(process.env.VIBEBOARD_PUBLIC_E2E_TIMEOUT_MS || 360000);
const REQUEST_TIMEOUT_MS = Number(process.env.VIBEBOARD_PUBLIC_E2E_REQUEST_TIMEOUT_MS || 70000);

const prompt = process.env.VIBEBOARD_PUBLIC_E2E_PROMPT || [
  "Create a clean 480x360 VibeBoard status screen.",
  "Show a blue hardware status panel, one large clock, and the sentence Runner render verification works.",
  "Keep every element inside the screen with high contrast.",
].join(" ");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(event, extra = {}) {
  console.log(JSON.stringify({ event, ...extra }));
}

function summarizeError(error) {
  const causes = [];
  const root = error?.cause || error;
  if (Array.isArray(root?.errors)) {
    for (const item of root.errors) {
      causes.push({
        code: item?.code || "",
        address: item?.address || "",
        port: item?.port || "",
        message: item?.message || "",
      });
    }
  }
  return {
    name: error?.name || "",
    message: error?.message || String(error || ""),
    code: error?.code || root?.code || "",
    causes,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function raw(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const response = await fetchWithTimeout(`${BASE_URL}${path}`, {
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    ...options,
  }, timeoutMs);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { response, status: response.status, data, text };
}

function cookieFrom(response) {
  return String(response.headers.get("set-cookie") || "").split(";")[0];
}

async function post(path, payload, cookie = "", timeoutMs = REQUEST_TIMEOUT_MS) {
  return raw(path, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: JSON.stringify(payload),
  }, timeoutMs);
}

async function get(path, cookie = "", timeoutMs = REQUEST_TIMEOUT_MS) {
  return raw(path, { headers: cookie ? { cookie } : {} }, timeoutMs);
}

function jobErrorSummary(job = {}) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    error: job.error,
    logs: Array.isArray(job.logs) ? job.logs.slice(-8) : [],
  };
}

async function waitForJob(jobId, cookie) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < TIMEOUT_MS) {
    const result = await get(`/api/jobs/${encodeURIComponent(jobId)}`, cookie, REQUEST_TIMEOUT_MS);
    assert(result.status === 200, `GET /api/jobs/${jobId} failed ${result.status}: ${result.text}`);
    last = result.data.job;
    if (["succeeded", "failed", "canceled"].includes(String(last?.status || ""))) return last;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error(`Job ${jobId} did not finish: ${JSON.stringify(jobErrorSummary(last))}`);
}

function findRenderEvidence(job = {}) {
  const output = job.output || {};
  const candidates = [
    output.buildEvidence,
    output.verificationResult,
    output.verification,
  ].filter(Boolean);
  for (const item of candidates) {
    const evidence = item.evidence || {};
    const data = item.data || {};
    const renderRunner = evidence.runner === true
      || evidence.render?.runner === true
      || data.runner === true
      || data.render?.runner === true;
    const screenshot = data.screenshot || data.render?.screenshot || evidence.screenshot || evidence.render?.screenshot || null;
    if (renderRunner || screenshot || /render/i.test(JSON.stringify(item))) {
      return { item, renderRunner, screenshot };
    }
  }
  return { item: null, renderRunner: false, screenshot: null };
}

try {
  await main();
} catch (error) {
  log("failed", {
    baseUrl: BASE_URL,
    error: summarizeError(error),
    hint: "If this fails before health on a vercel.app URL, check DNS/VPN/custom-domain access before debugging VibeBoard app code.",
  });
  process.exitCode = 1;
}

async function main() {
  log("start", { baseUrl: BASE_URL, phone: PHONE });

  const health = await get("/api/health", "", REQUEST_TIMEOUT_MS);
  assert(health.status === 200, `health failed ${health.status}: ${health.text}`);
  log("health", {
    publicDeployment: health.data?.publicDeployment,
    db: health.data?.db,
    billingMode: health.data?.billingMode,
  });

  let auth = await post("/api/auth/register", { phone: PHONE, password: PASSWORD });
  if (auth.status === 409 || /already/i.test(auth.text || "")) {
    auth = await post("/api/auth/login", { phone: PHONE, password: PASSWORD });
  }
  assert(auth.status === 200, `auth failed ${auth.status}: ${auth.text}`);
  const cookie = cookieFrom(auth.response);
  assert(cookie, "auth did not set a session cookie");
  log("auth", { role: auth.data?.user?.role || "" });

  const title = `Public E2E ${randomUUID().slice(0, 8)}`;
  const conversation = await post("/api/conversations", { title }, cookie);
  assert(conversation.status === 200, `conversation create failed ${conversation.status}: ${conversation.text}`);
  const conversationId = conversation.data?.id;
  assert(conversationId, "conversation create did not return id");
  log("conversation.created", { conversationId, title });

  const beforeList = await get("/api/conversations", cookie);
  assert(
    beforeList.status === 200 && beforeList.data?.conversations?.some(item => item.id === conversationId),
    `created conversation not listed: ${beforeList.text}`
  );
  log("conversation.listed", { count: beforeList.data?.conversations?.length || 0 });

  const jobResponse = await post("/api/jobs", {
    type: "generate",
    payload: {
      prompt,
      conversation_id: conversationId,
      background: true,
    },
  }, cookie, TIMEOUT_MS);
  assert([200, 202].includes(jobResponse.status), `job create failed ${jobResponse.status}: ${jobResponse.text}`);
  const initialJob = jobResponse.data?.job;
  assert(initialJob?.id, `job create did not return id: ${jobResponse.text}`);
  log("job.accepted", { jobId: initialJob.id, status: initialJob.status, phase: initialJob.phase });

  const job = ["succeeded", "failed", "canceled"].includes(String(initialJob.status || ""))
    ? initialJob
    : await waitForJob(initialJob.id, cookie);
  log("job.final", { jobId: job.id, status: job.status, phase: job.phase });
  assert(job.status === "succeeded", `job did not succeed: ${JSON.stringify(jobErrorSummary(job))}`);
  assert(job.output?.ok === true, `job output is not ok: ${JSON.stringify(job.output)}`);
  assert(job.output?.buildEvidence?.ok === true, `buildEvidence did not pass: ${JSON.stringify(job.output?.buildEvidence)}`);
  assert(job.output?.buildEvidence?.degraded !== true, `buildEvidence is degraded: ${JSON.stringify(job.output?.buildEvidence)}`);

  const render = findRenderEvidence(job);
  assert(render.renderRunner === true, `production job did not use remote render runner: ${JSON.stringify(job.output?.buildEvidence)}`);
  assert(render.screenshot?.bytes > 0 || render.screenshot?.base64, `render runner did not return screenshot evidence: ${JSON.stringify(render)}`);
  log("render.verified", {
    runner: render.renderRunner,
    screenshotBytes: render.screenshot?.bytes || 0,
    summary: render.item?.summary || "",
  });

  const files = await get(`/api/conversations/${encodeURIComponent(conversationId)}/files`, cookie);
  assert(files.status === 200, `conversation files failed ${files.status}: ${files.text}`);
  assert(files.data?.buildId === job.output.id, `conversation files build mismatch: ${files.text}`);
  assert(files.data?.files?.["index.html"], "conversation files should include index.html");
  log("conversation.files", { buildId: files.data?.buildId, fileCount: Object.keys(files.data?.files || {}).length });

  const afterList = await get("/api/conversations", cookie);
  assert(
    afterList.status === 200 && afterList.data?.conversations?.some(item => item.id === conversationId),
    `conversation disappeared after job: ${afterList.text}`
  );
  log("done", { ok: true, conversationId, jobId: job.id, buildId: job.output.id });
}
