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

async function textFetch(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  return text;
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
assert(Array.isArray(generate.buildGraph), "generate should include BuildGraph trace");
assert(generate.buildGraph.some(item => item.node === "template_generate"), "BuildGraph trace should include template_generate");

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

const audioStatus = await jsonFetch("/api/audio/status");
assert(audioStatus.ok === true, "/api/audio/status should return ok");
assert(audioStatus.mode === "offline-simulated" || audioStatus.mode === "real", "/api/audio/status should expose mode");
assert(Array.isArray(audioStatus.available_apis), "/api/audio/status should expose available audio APIs");
assert(audioStatus.available_apis.includes("/api/audio/record"), "audio status should advertise record API");

const audioRecord = await jsonFetch("/api/audio/record", {
  method: "POST",
  body: JSON.stringify({ duration: 2, file: "offline-smoke.wav" }),
});
assert(audioRecord.ok === true, "/api/audio/record should return ok");
assert(audioRecord.state?.recording === true, "offline record should mark recording state");

const audioStop = await jsonFetch("/api/audio/stop", {
  method: "POST",
  body: "{}",
});
assert(audioStop.ok === true, "/api/audio/stop should return ok");
assert(audioStop.state?.recording === false, "audio stop should clear recording state");

const audioPlay = await jsonFetch("/api/audio/play", {
  method: "POST",
  body: JSON.stringify({ file: "offline-smoke.wav" }),
});
assert(audioPlay.ok === true, "/api/audio/play should return ok");
assert(audioPlay.state?.playing === true, "offline play should mark playing state");

const createdConversationIds = [];
try {
  const conversationA = await jsonFetch("/api/conversations", { method: "POST" });
  const conversationB = await jsonFetch("/api/conversations", { method: "POST" });
  assert(conversationA.id && conversationB.id, "conversation creation should return ids");
  createdConversationIds.push(conversationA.id, conversationB.id);

  const promptA = "preview restore clock panel";
  const promptB = "preview restore weather panel";
  const generatedA = await jsonFetch("/api/generate", {
    method: "POST",
    body: JSON.stringify({
      prompt: promptA,
      conversation_id: conversationA.id,
      modelSettings: { enabled: false },
    }),
  });
  const generatedB = await jsonFetch("/api/generate", {
    method: "POST",
    body: JSON.stringify({
      prompt: promptB,
      conversation_id: conversationB.id,
      modelSettings: { enabled: false },
    }),
  });
  assert(generatedA.id !== generatedB.id, "separate conversations should get separate build ids");
  assert(generatedA.buildGraph?.some(item => item.node === "save_snapshot"), "conversation generate should save a snapshot through BuildGraph");

  const conversationC = await jsonFetch("/api/conversations", { method: "POST" });
  createdConversationIds.push(conversationC.id);
  const agentPrompt = "agent unified cyberpunk clock";
  const generatedC = await jsonFetch("/api/agent", {
    method: "POST",
    body: JSON.stringify({
      action: "confirm_build",
      build_prompt: agentPrompt,
      conversation_id: conversationC.id,
      modelSettings: { enabled: false },
      history: [{ role: "user", content: "确认按这个方案构建" }],
    }),
  });
  assert(generatedC.ok === true, "/api/agent confirm_build should succeed in template mode");
  assert(generatedC.mode === "build_done", "/api/agent confirm_build should report build_done");
  assert(Array.isArray(generatedC.agentGraph), "/api/agent should include AgentGraph trace");
  assert(generatedC.agentGraph.some(item => item.node === "build_graph"), "AgentGraph trace should include build_graph");
  assert(generatedC.buildGraph?.some(item => item.node === "save_snapshot"), "AgentGraph build should preserve BuildGraph snapshot save");

  const filesC = await jsonFetch(`/api/conversations/${conversationC.id}/files`);
  assert(filesC.buildId === generatedC.id, "agent conversation should keep its generated build id");
  const previewC = await textFetch(`/api/conversations/${conversationC.id}/preview/index.html`);
  assert(previewC.includes(generatedC.id), "agent conversation preview should show its build id");

  const filesA = await jsonFetch(`/api/conversations/${conversationA.id}/files`);
  assert(filesA.buildId === generatedA.id, "conversation A should keep its own build id");
  assert(filesA.files["hardware-result.json"], "conversation files should include hardware-result.json for restored previews");

  const previewA = await textFetch(`/api/conversations/${conversationA.id}/preview/index.html`);
  const previewB = await textFetch(`/api/conversations/${conversationB.id}/preview/index.html`);
  assert(previewA.includes(`/api/conversations/${conversationA.id}/preview/style.css`), "conversation A preview should load A scoped style.css");
  assert(previewA.includes(`/api/conversations/${conversationA.id}/preview/app.js`), "conversation A preview should load A scoped app.js");
  assert(previewA.includes(generatedA.id), "conversation A preview should keep A build id");
  assert(!previewA.includes(generatedB.id), "conversation A preview must not be overwritten by current build B");
  assert(previewB.includes(generatedB.id), "conversation B preview should show B build id");

  const appA = await textFetch(`/api/conversations/${conversationA.id}/preview/app.js`);
  assert(appA.includes(promptA), "conversation A app.js should keep A prompt");
  assert(!appA.includes(promptB), "conversation A app.js must not include B prompt");

  const hardwareA = await jsonFetch(`/api/conversations/${conversationA.id}/preview/hardware-result.json`, {
    headers: { accept: "application/json" },
  });
  assert(hardwareA.build_id === generatedA.id, "conversation A hardware result should match A build id");
} finally {
  for (const id of createdConversationIds) {
    try {
      await jsonFetch(`/api/conversations/${id}`, { method: "DELETE" });
    } catch {}
  }
}

console.log(JSON.stringify({
  ok: true,
  baseUrl: BASE_URL,
  buildId: generate.id,
  statusMode: status.mode,
  deployMode: deploy.mode,
  verifyMode: verify.goldenLoop.mode,
}, null, 2));
