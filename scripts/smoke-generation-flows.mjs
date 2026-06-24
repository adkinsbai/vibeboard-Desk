import { randomUUID } from "node:crypto";
import { assert, withServer } from "../tests/support/serverHarness.mjs";

const TASKS = [
  "随机生成一个极简股票行情小屏，三行数据，深色背景",
  "做一个天气和空气质量状态屏，突出温度和预警",
  "生成一个设备健康看板，显示 CPU、内存、网络和服务状态",
  "做一个番茄钟小屏，包含当前阶段、剩余时间和进度条",
  "生成一个音乐播放状态屏，包含曲名、音量和播放状态",
];

await withServer(async ({ baseUrl, json, text }) => {
  const results = [];
  const created = [];
  try {
    for (let i = 0; i < 4; i += 1) {
      const prompt = TASKS[(i + Math.floor(Math.random() * TASKS.length)) % TASKS.length];
      const generated = await json("/api/generate", {
        method: "POST",
        body: JSON.stringify({
          prompt: `${prompt} #${i + 1}`,
          modelSettings: { enabled: false },
        }),
      });
      assert(generated.ok === true, `direct generate ${i} should succeed`);
      assert(generated.buildEvidence?.ok === true, `direct generate ${i} should pass local verification`);
      results.push({ mode: "direct", id: generated.id });
    }

    const conversation = await json("/api/conversations", { method: "POST" });
    created.push(conversation.id);
    const agentGenerated = await json("/api/agent", {
      method: "POST",
      body: JSON.stringify({
        action: "confirm_build",
        build_prompt: "用 Agent 确认构建一个迷你会议日程小屏，包含三条日程和当前时间",
        conversation_id: conversation.id,
        modelSettings: { enabled: false },
        history: [{ role: "user", content: "开始吧" }],
      }),
    });
    assert(agentGenerated.ok === true, "agent confirm_build should succeed");
    assert(agentGenerated.mode === "build_done", "agent confirm_build should report build_done");
    results.push({ mode: "agent_confirm", id: agentGenerated.id, conversation: conversation.id });

    const previewHtml = await text(`/api/conversations/${conversation.id}/preview/index.html`);
    assert(previewHtml.includes(agentGenerated.id), "refresh-style restored preview should keep generated build id");
    const files = await json(`/api/conversations/${conversation.id}/files`);
    assert(files.buildId === agentGenerated.id, "refresh-style restored files should keep generated build id");

    const emptyResponse = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "", modelSettings: { enabled: false } }),
    });
    const empty = await emptyResponse.json();
    assert(emptyResponse.status === 400, "empty generate should be HTTP 400");
    assert(empty.errorType === "empty_prompt", "empty generate should return empty_prompt");
    assert(empty.userMessage && empty.suggestion, "empty generate should include actionable guidance");

    const concurrent = await Promise.allSettled([
      fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `并发任务 A ${randomUUID()}`, modelSettings: { enabled: false } }),
      }).then(async response => ({ status: response.status, body: await response.json() })),
      fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: `并发任务 B ${randomUUID()}`, modelSettings: { enabled: false } }),
      }).then(async response => ({ status: response.status, body: await response.json() })),
    ]);
    const bodies = concurrent.map(item => item.status === "fulfilled" ? item.value : { error: item.reason?.message });
    const successes = bodies.filter(item => item.body?.ok === true).length;
    const busy = bodies.filter(item => item.status === 409 && item.body?.errorType === "generate_busy").length;
    assert(successes >= 1, `at least one concurrent generate should succeed: ${JSON.stringify(bodies)}`);
    assert(successes + busy === 2, `second concurrent generate should either finish after first or return generate_busy: ${JSON.stringify(bodies)}`);

    console.log(JSON.stringify({
      ok: true,
      baseUrl,
      results,
      emptyError: { status: emptyResponse.status, errorType: empty.errorType },
      concurrent: bodies.map(item => ({ status: item.status, ok: item.body?.ok, errorType: item.body?.errorType || "" })),
    }, null, 2));
  } finally {
    for (const id of created) {
      try {
        await json(`/api/conversations/${id}`, { method: "DELETE" });
      } catch {}
    }
  }
}, {
  dbPrefix: "vibeboard-generation-flow-smoke",
});
