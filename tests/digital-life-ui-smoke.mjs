import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

async function main() {
  await withServer(async ({ baseUrl }) => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
    try {
      await page.goto(`${baseUrl}/digital-life.html`, { waitUntil: "networkidle" });
      await page.evaluate(() => {
        localStorage.setItem("vibeboard-digital-life-model-settings", JSON.stringify({ enabled: false, apiKey: "", baseUrl: "", model: "" }));
        window.__vibeboardSubmitCount = 0;
        document.getElementById("lifeComposer")?.addEventListener("submit", () => {
          window.__vibeboardSubmitCount = (window.__vibeboardSubmitCount || 0) + 1;
        }, { capture: true });
      });
      await page.locator("#lifeInput").fill("测试 Enter 发送，记住我喜欢安静一点的回答");
      const messageResponse = page.waitForResponse(
        response => response.url().includes("/api/digital-life/message") && response.request().method() === "POST",
        { timeout: 20000 },
      );
      await page.keyboard.press("Enter");
      const submitCount = await page.waitForFunction(() => window.__vibeboardSubmitCount > 0, null, { timeout: 3000 })
        .then(() => page.evaluate(() => window.__vibeboardSubmitCount || 0))
        .catch(() => 0);
      if (submitCount === 0) {
        await page.locator("#lifeComposer button[type='submit']").click();
      }

      await page.locator(".msg.user", { hasText: "测试 Enter 发送" }).waitFor({ timeout: 6000 });
      const response = await messageResponse;
      assert(response.ok(), `/api/digital-life/message should succeed, got HTTP ${response.status()}`);
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll(".msg.assistant"))
          .some(node => node.textContent && !/local-first digital life companion/i.test(node.textContent)),
        null,
        { timeout: 20000 },
      ).catch(async error => {
        const diagnostics = await page.evaluate(() => ({
          assistants: Array.from(document.querySelectorAll(".msg.assistant")).map(node => node.textContent?.slice(0, 160) || ""),
          users: Array.from(document.querySelectorAll(".msg.user")).map(node => node.textContent?.slice(0, 160) || ""),
          status: document.getElementById("modelStatus")?.textContent || "",
          messageLog: document.getElementById("messageLog")?.textContent?.slice(0, 1000) || "",
        }));
        throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
      });

      const userMessage = await page.locator(".msg.user", { hasText: "测试 Enter 发送" }).count();
      assert(userMessage >= 1, "Enter should submit and render the user message immediately");

      await page.locator("#innerStateSummary").waitFor({ timeout: 6000 });
      await page.locator("#autonomySummary").waitFor({ timeout: 6000 });
      await page.locator("#cognitionSummary").waitFor({ timeout: 6000 });
      await page.locator(".mind-drawer").waitFor({ timeout: 6000 });

      const mindOpenInitially = await page.locator(".mind-drawer").evaluate(node => node.open);
      assert(mindOpenInitially === false, "mind panel should stay folded by default");
      await page.locator(".mind-drawer summary").click();
      await page.locator("#mindPanel", { hasText: "goals" }).waitFor({ timeout: 6000 });
      await page.locator("#mindPanel", { hasText: "attention" }).waitFor({ timeout: 6000 });

      const canvasMetrics = await page.locator("#lifeExpression").evaluate(canvas => {
        const ctx = canvas.getContext("2d");
        const sample = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let nonblank = 0;
        for (let index = 3; index < sample.length; index += 4) {
          if (sample[index] > 0) nonblank += 1;
          if (nonblank > 10) break;
        }
        return {
          width: canvas.width,
          height: canvas.height,
          expressionState: canvas.dataset.expressionState || "",
          nonblank,
        };
      });
      assert(canvasMetrics.width > 100 && canvasMetrics.height > 80, "expression canvas should have stable dimensions");
      assert(canvasMetrics.nonblank > 10, "expression canvas should render nonblank pixels");
      assert(canvasMetrics.expressionState.length > 0, "expression canvas should expose expression state");

      const internalTextVisible = await page.getByText("结合记忆思考中").count();
      assert(internalTextVisible === 0, "UI should not expose internal memory-thinking status text");

      const messageLogMetrics = await page.locator("#messageLog").evaluate(node => ({
        scrollTop: node.scrollTop,
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      }));
      assert(messageLogMetrics.scrollHeight >= messageLogMetrics.clientHeight, "message log should have stable dimensions");

      console.log(JSON.stringify({
        ok: true,
        baseUrl,
        userMessage,
        messageLogMetrics,
      }, null, 2));
    } finally {
      await browser.close();
    }
  }, {
    dbPrefix: "vibeboard-ui-test",
    env: {
      VIBEBOARD_LLM_API_KEY: "",
      VIBEBOARD_MODEL_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      OPENAI_API_KEY: "",
    },
  });
}

try {
  await main();
} catch (error) {
  console.error(`FAIL digital-life UI smoke: ${error?.message || error}`);
  process.exitCode = 1;
}
