import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl, json, text }) => {
const generate = await json("/api/generate", {
  method: "POST",
  body: JSON.stringify({
    prompt: "offline acceptance dashboard",
    modelSettings: { enabled: false },
  }),
});
assert(generate.ok === true, "/api/generate should succeed in template mode");
assert(generate.buildEvidence?.ok === true, "generate should include passing buildEvidence");
assert(generate.intelligenceSummary?.confidence === "local_verified", "generate should include local verified intelligence summary");
assert(generate.intelligenceSummary?.nextBestAction === "deploy_to_board", "generate intelligence should suggest deploy_to_board");
assert(generate.intelligenceSummary?.userMoment?.includes(generate.id), "generate intelligence should mention current build id");
assert(generate.verificationMode === "local-simulated", "generate should expose local-simulated verificationMode");
assert(Array.isArray(generate.buildGraph), "generate should include BuildGraph trace");
assert(generate.buildGraph.some(item => item.node === "template_generate"), "BuildGraph trace should include template_generate");

const emptyGenerateResponse = await fetch(`${baseUrl}/api/generate`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "", modelSettings: { enabled: false } }),
});
const emptyGenerate = await emptyGenerateResponse.json();
assert(emptyGenerateResponse.status === 400, "/api/generate should return 400 for empty prompt");
assert(emptyGenerate.ok === false, "empty generate should return ok:false");
assert(emptyGenerate.errorType === "empty_prompt", `empty prompt should be classified, got ${JSON.stringify(emptyGenerate)}`);
assert(emptyGenerate.userMessage && emptyGenerate.suggestion, "empty prompt should include user-facing guidance");

const published = await json("/api/market/publish", {
  method: "POST",
  body: JSON.stringify({
    name: "Offline acceptance dashboard",
    description: "Published directly after generation to verify preview capture.",
  }),
});
assert(published.ok === true, "/api/market/publish should succeed");
assert(published.preview_url?.startsWith("/api/previews/"), "market publish should return a generated preview_url");
assert(published.previewReport?.ok === true, `market publish preview capture should pass: ${JSON.stringify(published.previewReport)}`);
assert(published.previewReport?.buildId === generate.id, "market publish preview should match the current build id");

const publishedPreview = await text(published.preview_url);
assert(publishedPreview.length > 1000, "published preview image should be served with content");

const market = await json("/api/market");
const publishedApp = market.apps.find(app => app.id === published.id);
assert(publishedApp?.preview_url === published.preview_url, "market listing should persist preview_url");

const publishedDetail = await json(`/api/market/${encodeURIComponent(published.id)}`);
assert(publishedDetail.ok === true, "/api/market/:id should return ok for published app");
assert(publishedDetail.app?.preview_url === published.preview_url, "market detail should persist preview_url");

const invalidPublishResponse = await fetch(`${baseUrl}/api/market/publish`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "" }),
});
const invalidPublish = await invalidPublishResponse.json();
assert(invalidPublishResponse.status === 400, "/api/market/publish should return 400 for missing name");
assert(invalidPublish.ok === false, "invalid market publish should return ok:false");

const status = await json("/api/status");
assert(status.mode === "offline-simulated" || status.mode === "real", "/api/status should expose mode");
assert("connected" in status, "/api/status should expose connected");

const deploy = await json("/api/deploy", {
  method: "POST",
  body: "{}",
});
assert(deploy.ok === true, "/api/deploy should return ok response in offline mode");
assert(deploy.skipped === true, "/api/deploy should mark offline deploy as skipped");
assert(deploy.mode === "offline-simulated", "/api/deploy should expose offline-simulated mode");
assert(deploy.goldenLoop?.skipped === true, "offline deploy should include skipped goldenLoop");
assert(deploy.buildEvidence?.ok === true, "offline deploy should carry local buildEvidence");
assert(deploy.intelligenceSummary?.confidence === "local_verified", "offline deploy should carry build intelligence summary");

async function waitForJob(id, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const data = await json(`/api/jobs/${encodeURIComponent(id)}`);
    assert(data.ok === true && data.job?.id === id, `${label} job should be readable`);
    if (["succeeded", "failed", "canceled"].includes(data.job.status)) return data.job;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label} job did not finish`);
}

const backgroundAgent = await json("/api/agent", {
  method: "POST",
  body: JSON.stringify({
    action: "confirm_build",
    build_prompt: "background job smoke dashboard",
    conversation_id: "",
    background: true,
    modelSettings: { enabled: false },
  }),
});
assert(backgroundAgent.ok === true && backgroundAgent.job?.id, "/api/agent background mode should create a job");
const backgroundAgentDone = await waitForJob(backgroundAgent.job.id, "agent background");
assert(backgroundAgentDone.status === "succeeded", `background agent job should succeed: ${JSON.stringify(backgroundAgentDone.error)}`);
assert(backgroundAgentDone.output?.mode === "build_done", "background agent job should keep build_done output");
assert(backgroundAgentDone.choices?.some(choice => choice.action === "open_result"), "background generate job should expose open_result choice");

const backgroundDeploy = await json("/api/deploy", {
  method: "POST",
  body: JSON.stringify({ background: true }),
});
assert(backgroundDeploy.ok === true && backgroundDeploy.job?.id, "/api/deploy background mode should create a job");
const backgroundDeployDone = await waitForJob(backgroundDeploy.job.id, "deploy background");
assert(backgroundDeployDone.status === "succeeded", `background deploy should succeed offline: ${JSON.stringify(backgroundDeployDone.error)}`);
assert(backgroundDeployDone.output?.skipped === true, "background deploy should preserve offline skipped result");

const listedJobs = await json("/api/jobs?limit=10");
assert(listedJobs.jobs?.some(job => job.id === backgroundAgent.job.id), "/api/jobs should list background jobs");

const verify = await json(`/api/verify?id=${encodeURIComponent(generate.id)}`);
assert(verify.ok === true, "/api/verify should return ok wrapper in offline mode");
assert(verify.skipped === true, "/api/verify should be skipped offline");
assert(verify.goldenLoop?.mode === "offline-simulated", "/api/verify should expose offline golden loop mode");

const audioStatus = await json("/api/audio/status");
assert(audioStatus.ok === true, "/api/audio/status should return ok");
assert(audioStatus.mode === "offline-simulated" || audioStatus.mode === "real", "/api/audio/status should expose mode");
assert(Array.isArray(audioStatus.available_apis), "/api/audio/status should expose available audio APIs");
assert(audioStatus.available_apis.includes("/api/audio/record"), "audio status should advertise record API");

const audioRecord = await json("/api/audio/record", {
  method: "POST",
  body: JSON.stringify({ duration: 2, file: "offline-smoke.wav" }),
});
assert(audioRecord.ok === true, "/api/audio/record should return ok");
assert(audioRecord.state?.recording === true, "offline record should mark recording state");

const audioStop = await json("/api/audio/stop", {
  method: "POST",
  body: "{}",
});
assert(audioStop.ok === true, "/api/audio/stop should return ok");
assert(audioStop.state?.recording === false, "audio stop should clear recording state");

const audioPlay = await json("/api/audio/play", {
  method: "POST",
  body: JSON.stringify({ file: "offline-smoke.wav" }),
});
assert(audioPlay.ok === true, "/api/audio/play should return ok");
assert(audioPlay.state?.playing === true, "offline play should mark playing state");

const createdConversationIds = [];
try {
  const conversationA = await json("/api/conversations", { method: "POST" });
  const conversationB = await json("/api/conversations", { method: "POST" });
  assert(conversationA.id && conversationB.id, "conversation creation should return ids");
  assert(conversationA.project_dir, "conversation creation should return a project folder");
  createdConversationIds.push(conversationA.id, conversationB.id);

  const uploadedAsset = await json(`/api/conversations/${conversationA.id}/assets`, {
    method: "POST",
    body: JSON.stringify({
      assets: [{
        name: "palette.txt",
        mime: "text/plain",
        encoding: "base64",
        content: Buffer.from("primary #22c55e\naccent #38bdf8\n").toString("base64"),
      }],
    }),
  });
  assert(uploadedAsset.ok === true && uploadedAsset.assets?.length === 1, "asset upload should succeed");
  await new Promise(resolve => setTimeout(resolve, 250));
  const assetList = await json(`/api/conversations/${conversationA.id}/assets`);
  const asset = assetList.assets?.[0];
  assert(assetList.folders?.some(folder => folder.name === "图片"), "asset API should expose image folder");
  assert(assetList.folders?.some(folder => folder.name === "视频"), "asset API should expose video folder");
  assert(assetList.folders?.some(folder => folder.name === "音频"), "asset API should expose audio folder");
  assert(assetList.folders?.some(folder => folder.name === "其他"), "asset API should expose other folder");
  assert(asset?.project_path?.includes("palette.txt"), `asset should persist into project folder: ${JSON.stringify(asset)}`);
  const otherFolder = assetList.folders.find(folder => folder.name === "其他");
  assert(asset.folder_id === otherFolder.id, "text asset should auto-classify into other folder");
  const customFolder = await json(`/api/conversations/${conversationA.id}/asset-folders`, {
    method: "POST",
    body: JSON.stringify({ name: "参考素材" }),
  });
  assert(customFolder.folder?.name === "参考素材", "custom folder should be creatable");
  const renamedFolder = await json(`/api/conversations/${conversationA.id}/asset-folders/${encodeURIComponent(customFolder.folder.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "视觉参考" }),
  });
  assert(renamedFolder.folder?.name === "视觉参考", "custom folder should be renameable");
  const deletedFolder = await json(`/api/conversations/${conversationA.id}/asset-folders/${encodeURIComponent(customFolder.folder.id)}`, {
    method: "DELETE",
  });
  assert(deletedFolder.ok === true && deletedFolder.moved_to, "custom folder should be deleteable");
  const renamed = await json(`/api/conversations/${conversationA.id}/assets/${encodeURIComponent(asset.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: "palette-renamed.txt", usage: "reference_only" }),
  });
  assert(renamed.asset?.name === "palette-renamed.txt", "asset rename should update metadata");
  assert(renamed.asset?.usage === "reference_only", "asset usage should update metadata");
  const projectFilesBeforeGenerate = await json(`/api/conversations/${conversationA.id}/project-files`);
  assert(projectFilesBeforeGenerate.files?.some(file => file.path.includes("palette-renamed.txt")), "project files should show renamed asset");

  const promptA = "preview restore clock panel";
  const promptB = "preview restore weather panel";
  const generatedA = await json("/api/generate", {
    method: "POST",
    body: JSON.stringify({
      prompt: promptA,
      conversation_id: conversationA.id,
      modelSettings: { enabled: false },
    }),
  });
  const generatedB = await json("/api/generate", {
    method: "POST",
    body: JSON.stringify({
      prompt: promptB,
      conversation_id: conversationB.id,
      modelSettings: { enabled: false },
    }),
  });
  assert(generatedA.id !== generatedB.id, "separate conversations should get separate build ids");
  assert(generatedA.buildGraph?.some(item => item.node === "save_snapshot"), "conversation generate should save a snapshot through BuildGraph");
  const projectFilesA = await json(`/api/conversations/${conversationA.id}/project-files`);
  assert(projectFilesA.files?.some(file => file.path === "MEMORY.md"), "project files should include MEMORY.md after generation");
  assert(projectFilesA.files?.some(file => file.path.includes(`/asset-snapshot.json`) || file.path.endsWith("asset-snapshot.json")), "project files should include build asset snapshot");

  const conversationC = await json("/api/conversations", { method: "POST" });
  createdConversationIds.push(conversationC.id);
  const agentPrompt = "agent unified cyberpunk clock";
  const generatedC = await json("/api/agent", {
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

  const filesC = await json(`/api/conversations/${conversationC.id}/files`);
  assert(filesC.buildId === generatedC.id, "agent conversation should keep its generated build id");
  const previewC = await text(`/api/conversations/${conversationC.id}/preview/index.html`);
  assert(previewC.includes(generatedC.id), "agent conversation preview should show its build id");

  const filesA = await json(`/api/conversations/${conversationA.id}/files`);
  assert(filesA.buildId === generatedA.id, "conversation A should keep its own build id");
  assert(filesA.files["hardware-result.json"], "conversation files should include hardware-result.json for restored previews");

  const previewA = await text(`/api/conversations/${conversationA.id}/preview/index.html`);
  const previewB = await text(`/api/conversations/${conversationB.id}/preview/index.html`);
  assert(previewA.includes(`/api/conversations/${conversationA.id}/preview/style.css`), "conversation A preview should load A scoped style.css");
  assert(previewA.includes(`/api/conversations/${conversationA.id}/preview/app.js`), "conversation A preview should load A scoped app.js");
  assert(previewA.includes(generatedA.id), "conversation A preview should keep A build id");
  assert(!previewA.includes(generatedB.id), "conversation A preview must not be overwritten by current build B");
  assert(previewB.includes(generatedB.id), "conversation B preview should show B build id");

  const appA = await text(`/api/conversations/${conversationA.id}/preview/app.js`);
  assert(appA.includes(promptA), "conversation A app.js should keep A prompt");
  assert(!appA.includes(promptB), "conversation A app.js must not include B prompt");

  const hardwareA = await json(`/api/conversations/${conversationA.id}/preview/hardware-result.json`, {
    headers: { accept: "application/json" },
  });
  assert(hardwareA.build_id === generatedA.id, "conversation A hardware result should match A build id");
} finally {
  for (const id of createdConversationIds) {
    try {
      await json(`/api/conversations/${id}`, { method: "DELETE" });
    } catch {}
  }
}

console.log(JSON.stringify({
  ok: true,
  baseUrl,
  buildId: generate.id,
  statusMode: status.mode,
  deployMode: deploy.mode,
  verifyMode: verify.goldenLoop.mode,
}, null, 2));
});
