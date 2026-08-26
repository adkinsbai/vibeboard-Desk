import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

await withServer(async ({ baseUrl, json }) => {
  const first = await json("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "Project A" }),
  });
  const second = await json("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "Project B" }),
  });
  assert(first.id && second.id, "setup should create two conversations");

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
  try {
    await page.goto(`${baseUrl}/studio/workbench`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatLog").waitFor({ timeout: 6000 });
    await page.evaluate(({ firstId, secondId }) => {
      const originalFetch = window.fetch.bind(window);
      let jobReads = 0;
      const persisted = {
        [firstId]: [{ role: "user", content: "Build Project A" }],
        [secondId]: [],
      };
      window.__switchingJob = {
        id: "job-project-a",
        type: "generate",
        status: "running",
        phase: "generate",
        conversation_id: firstId,
        title: "Generate Project A",
        logs: [{ phase: "generate", message: "still running" }],
      };

      window.fetch = (input, init = {}) => {
        const url = typeof input === "string" ? input : input?.url || "";
        const method = String(init?.method || "GET").toUpperCase();
        if (url.endsWith("/api/generate") && method === "POST") {
          window.__switchingGenerateStarted = true;
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            job: window.__switchingJob,
          }), { status: 202, headers: { "content-type": "application/json" } }));
        }
        if (url.includes("/api/jobs/job-project-a") && method === "GET") {
          jobReads += 1;
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            job: window.__switchingJob,
          }), { status: 200, headers: { "content-type": "application/json" } }));
        }
        if (url.includes("/api/jobs?") && method === "GET") {
          const conversationId = new URL(url, window.location.origin).searchParams.get("conversation_id");
          const jobs = conversationId === firstId ? [window.__switchingJob] : [];
          return Promise.resolve(new Response(JSON.stringify({ ok: true, jobs }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        const messageMatch = url.match(/\/api\/conversations\/([^/]+)\/messages$/);
        if (messageMatch && method === "GET") {
          const conversationId = decodeURIComponent(messageMatch[1]);
          return Promise.resolve(new Response(JSON.stringify({ ok: true, messages: persisted[conversationId] || [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        if (messageMatch && method === "POST") {
          const conversationId = decodeURIComponent(messageMatch[1]);
          const body = JSON.parse(init.body || "{}");
          persisted[conversationId] ||= [];
          persisted[conversationId].push(body);
          return Promise.resolve(new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        if (url.includes("/api/conversations/") && url.endsWith("/files") && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify({ ok: true, files: {}, buildId: null }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        if (url.includes("/api/conversations/") && url.endsWith("/memory") && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify({ ok: true, project_memory: {} }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        if (url.includes("/api/conversations/") && url.endsWith("/assets") && method === "GET") {
          return Promise.resolve(new Response(JSON.stringify({ ok: true, summary: { count: 0, totalBytes: 0, byKind: {}, items: [] } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
        }
        if (url.includes("/api/conversations") && method === "GET") {
          return originalFetch(input, init);
        }
        return originalFetch(input, init);
      };
      window.__switchingJobReads = () => jobReads;
    }, { firstId: first.id, secondId: second.id });

    await page.locator(`.conv-item[data-id="${first.id}"]`).click();
    await page.locator(`.conv-item.active[data-id="${first.id}"]`).waitFor({ timeout: 6000 });
    await page.evaluate(({ firstId }) => {
      window.__switchingFlow = window.runFlow("Build Project A", [], firstId);
    }, { firstId: first.id });
    await page.waitForFunction(() => window.__switchingGenerateStarted === true, { timeout: 6000 });

    await page.locator(`.conv-item[data-id="${second.id}"]`).evaluate(node => node.click());
    await page.waitForFunction(expected => [...document.querySelectorAll(".conv-item.active")].some(item => item.dataset.id === expected), second.id, { timeout: 6000 }).catch(async error => {
      throw new Error(`${error.message}; active=${await page.locator(".conv-item.active").evaluateAll(items => items.map(item => item.dataset.id))}`);
    });
    await page.locator(`.conv-item[data-id="${first.id}"]`).evaluate(node => node.click());
    await page.locator(`.conv-item.active[data-id="${first.id}"]`).waitFor({ timeout: 6000 });
    await page.waitForFunction(() => !document.body.textContent.includes("加载对话记录中..."));

    const restored = await page.evaluate(() => ({
      chat: document.querySelector("#chatLog")?.textContent || "",
      jobReads: window.__switchingJobReads(),
      jobCards: [...document.querySelectorAll(".job-card")].map(card => card.textContent || ""),
    }));
    assert(restored.chat.includes("我开始执行您的任务"), "switching back should restore the in-progress execution message");
    assert(restored.jobReads > 0, "switching back should query jobs for the selected conversation");
    assert(restored.jobCards.some(text => text.includes("job-project-a") || text.includes("Generate Project A")), "selected project should show its running job");
    await page.evaluate(() => {
      window.__switchingJob = { ...window.__switchingJob, status: "canceled", phase: "canceled" };
    });
    await page.evaluate(() => window.__switchingFlow?.catch(() => {}));
  } finally {
    await browser.close();
  }
}, { dbPrefix: "conversation-switching", wait: { path: "/api/health" } });

console.log("conversation switching persistence ok");
