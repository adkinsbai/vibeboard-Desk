import assert from "node:assert/strict";
import { chromium } from "playwright";
import { assert as harnessAssert, withServer } from "./support/serverHarness.mjs";

const APP_PATH = "/market-apps/vb-digital-life-companion-demo/index.html";

async function runTextHydration() {
  await withServer(async ({ baseUrl }) => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
    const calls = [];
    try {
      await page.route("**/api/digital-life/**", async route => {
        const request = route.request();
        const url = new URL(request.url());
        calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON?.() });
        if (url.pathname === "/api/digital-life/state") {
          return route.fulfill({ json: { ok: true, state: { mood: "curious", energy: 72, mind: { expression: "curious" } } } });
        }
        if (url.pathname === "/api/digital-life/memories") {
          return route.fulfill({ json: { ok: true, memories: [{ id: "real-1", title: "陪伴边界", kind: "preference", content: "安静陪伴，不替用户决定", importance: 5 }] } });
        }
        if (url.pathname === "/api/digital-life/messages") {
          return route.fulfill({ json: { ok: true, messages: [{ id: "u1", role: "user", content: "早上好" }, { id: "a1", role: "assistant", content: "早上好，我在。" }] } });
        }
        if (url.pathname === "/api/digital-life/speech/status") {
          return route.fulfill({ json: { ok: true, configured: false, transcription: false, synthesis: false, max_recording_seconds: 60 } });
        }
        if (url.pathname === "/api/digital-life/message") {
          return route.fulfill({ json: { ok: true, assistant_message: { id: "a2", role: "assistant", content: "听起来你需要慢一点。" }, state: { mood: "warm", mind: { expression: "warm" } }, mode: "offline_mock", fallback_reason: "model unavailable" } });
        }
        return route.fulfill({ status: 404, json: { ok: false, error: "fixture route missing" } });
      });

      await page.goto(`${baseUrl}${APP_PATH}`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator?.getState().connection_mode === "online", null, { timeout: 3000 });

      const snapshot = await page.evaluate(() => window.DigitalLifeDeviceSimulator.getState());
      assert.equal(snapshot.expression, "curious");
      assert.equal(snapshot.memories[0].id, "real-1");
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.speech.configured, false);

      const layout = await page.evaluate(() => {
        const rect = selector => {
          const value = document.querySelector(selector).getBoundingClientRect();
          return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
        };
        return {
          viewport: { width: innerWidth, height: innerHeight },
          scrollWidth: document.documentElement.scrollWidth,
          mood: rect("#moodLine"),
          conversation: rect(".conversation-panel"),
          controls: rect(".controls"),
          leftEye: rect(".eye-left"),
          rightEye: rect(".eye-right"),
          mouth: rect(".mouth"),
        };
      });
      assert(layout.scrollWidth <= layout.viewport.width, "480x360 should have no horizontal overflow");
      assert(layout.mood.bottom <= layout.conversation.top, `mood should not overlap conversation: ${JSON.stringify(layout)}`);
      assert(layout.conversation.bottom <= layout.controls.top, `conversation should not overlap controls: ${JSON.stringify(layout)}`);
      assert(layout.leftEye.width > 0 && layout.rightEye.width > 0 && layout.mouth.width > 0, "eyes and mouth should be visible foreground elements");

      await page.locator("#key2").click();
      await page.locator("#memoryResults").getByText("安静陪伴，不替用户决定").waitFor({ timeout: 2000 });
      await page.locator("#closeMemory").click();

      await page.locator("#messageInput").fill("今天有点累");
      await page.locator("#sendMessage").click();
      await page.locator(".message-assistant", { hasText: "听起来你需要慢一点。" }).waitFor({ timeout: 3000 });
      const afterReply = await page.evaluate(() => window.DigitalLifeDeviceSimulator.getState());
      assert.equal(afterReply.expression, "warm");
      assert(calls.some(call => call.path === "/api/digital-life/message" && call.method === "POST"));
      const messageCall = calls.find(call => call.path === "/api/digital-life/message");
      assert.deepEqual(Object.keys(messageCall.body).sort(), ["content", "conversation_id"]);
      assert.equal(messageCall.body.content, "今天有点累");
      assert(!JSON.stringify(calls).match(/apiKey|api_key|secret|authorization/i));
    } finally {
      await browser.close();
    }
  }, {
    dbPrefix: "vibeboard-market-companion-test",
    env: {
      VIBEBOARD_LLM_API_KEY: "",
      VIBEBOARD_MODEL_API_KEY: "",
      DEEPSEEK_API_KEY: "",
      OPENAI_API_KEY: "",
      DIGITAL_LIFE_AUTOSTART: "0",
    },
  });
}

async function runVoiceFlow() {
  await withServer(async ({ baseUrl }) => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
    const calls = [];
    try {
      await page.addInitScript(() => {
        const track = { stopped: false, stop() { this.stopped = true; } };
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
        });
        class FakeAudioContext {
          constructor() { this.sampleRate = 48000; this.destination = {}; }
          createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
          createScriptProcessor() {
            const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
            window.__voiceProcessor = processor;
            return processor;
          }
          async close() {}
        }
        window.AudioContext = FakeAudioContext;
        window.Audio = class {
          constructor(url) { this.url = url; this.onended = null; this.onerror = null; }
          async play() {
            setTimeout(() => this.onended?.(), 10);
          }
        };
        window.__expressionSequence = [];
        document.addEventListener("DOMContentLoaded", () => {
          new MutationObserver(() => window.__expressionSequence.push(document.body.dataset.expression || ""))
            .observe(document.body, { attributes: true, attributeFilter: ["data-expression"] });
        });
      });

      await page.route("**/api/digital-life/**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        calls.push({ path, method: request.method(), body: request.postDataJSON?.() });
        if (path === "/api/digital-life/state") return route.fulfill({ json: { ok: true, state: { mood: "idle", mind: { expression: "idle" } } } });
        if (path === "/api/digital-life/memories") return route.fulfill({ json: { ok: true, memories: [] } });
        if (path === "/api/digital-life/messages") return route.fulfill({ json: { ok: true, messages: [] } });
        if (path === "/api/digital-life/speech/status") return route.fulfill({ json: { ok: true, configured: true, transcription: true, synthesis: true, max_recording_seconds: 60 } });
        if (path === "/api/digital-life/speech/transcribe") return route.fulfill({ json: { ok: true, transcript: "今天想安静一点", provider: "iflytek" } });
        if (path === "/api/digital-life/message") return route.fulfill({ json: { ok: true, assistant_message: { role: "assistant", content: "好，我们慢一点。" }, state: { mood: "warm", mind: { expression: "warm" } }, mode: "deepseek" } });
        if (path === "/api/digital-life/speech/synthesize") return route.fulfill({ json: { ok: true, audio_base64: btoa("mock-mp3-audio"), mime: "audio/mpeg", provider: "iflytek" } });
        return route.fulfill({ status: 404, json: { ok: false } });
      });

      await page.goto(`${baseUrl}${APP_PATH}`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator?.getState().speech.transcription === true);
      await page.locator("#micButton").click();
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator.getState().conversation_state === "listening");
      await page.evaluate(() => {
        const samples = new Float32Array(4800);
        samples.fill(.25);
        window.__voiceProcessor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
      });
      await page.locator("#micButton").click();
      await page.locator(".message-assistant", { hasText: "好，我们慢一点。" }).waitFor({ timeout: 5000 });
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator.getState().expression === "warm", null, { timeout: 5000 });

      const speechCalls = calls.filter(call => [
        "/api/digital-life/speech/transcribe",
        "/api/digital-life/message",
        "/api/digital-life/speech/synthesize",
      ].includes(call.path));
      assert.deepEqual(speechCalls.map(call => call.path), [
        "/api/digital-life/speech/transcribe",
        "/api/digital-life/message",
        "/api/digital-life/speech/synthesize",
      ]);
      assert.equal(Buffer.from(speechCalls[0].body.audio_base64, "base64").byteLength, 3200);
      assert.equal(speechCalls[0].body.sample_rate, 16000);
      const sequence = await page.evaluate(() => window.__expressionSequence);
      const listening = sequence.indexOf("listening");
      const thinking = sequence.indexOf("thinking", listening + 1);
      const speaking = sequence.indexOf("speaking", thinking + 1);
      const warm = sequence.indexOf("warm", speaking + 1);
      assert(listening >= 0 && thinking > listening && speaking > thinking && warm > speaking, `expression sequence should be ordered, got ${sequence.join(" -> ")}`);
      const snapshot = await page.evaluate(() => window.DigitalLifeDeviceSimulator.getState());
      assert.equal(snapshot.expression, "warm");
      assert(!/audio_base64|raw_audio|pcm/i.test(JSON.stringify(snapshot)), "snapshot should retain no raw microphone audio");
    } finally {
      await browser.close();
    }
  }, {
    dbPrefix: "vibeboard-market-voice-test",
    env: { DIGITAL_LIFE_AUTOSTART: "0" },
  });
}

async function runFailureModes() {
  await withServer(async ({ baseUrl }) => {
    const browser = await chromium.launch();
    try {
      for (const mode of ["microphone", "stt", "tts", "autoplay"]) {
        const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
        const calls = [];
        await page.addInitScript(failureMode => {
          Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: {
              getUserMedia: async () => {
                if (failureMode === "microphone") throw new Error("permission denied");
                return { getTracks: () => [{ stop() {} }] };
              },
            },
          });
          window.AudioContext = class {
            constructor() { this.sampleRate = 16000; this.destination = {}; }
            createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
            createScriptProcessor() {
              const processor = { connect() {}, disconnect() {}, onaudioprocess: null };
              window.__failureProcessor = processor;
              return processor;
            }
            async close() {}
          };
          window.Audio = class {
            async play() {
              if (failureMode === "autoplay") throw new Error("autoplay blocked");
              setTimeout(() => this.onended?.(), 5);
            }
          };
        }, mode);
        await page.route("**/api/digital-life/**", async route => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          calls.push(path);
          if (path === "/api/digital-life/state") return route.fulfill({ json: { ok: true, state: { mood: "idle", mind: { expression: "idle" } } } });
          if (path === "/api/digital-life/memories") return route.fulfill({ json: { ok: true, memories: [] } });
          if (path === "/api/digital-life/messages") return route.fulfill({ json: { ok: true, messages: [] } });
          if (path === "/api/digital-life/speech/status") return route.fulfill({ json: { ok: true, configured: true, transcription: true, synthesis: true, max_recording_seconds: 60 } });
          if (path === "/api/digital-life/speech/transcribe") {
            if (mode === "stt") return route.fulfill({ status: 503, json: { ok: false, error: "speech_unavailable" } });
            return route.fulfill({ json: { ok: true, transcript: "测试语音", provider: "iflytek" } });
          }
          if (path === "/api/digital-life/message") return route.fulfill({ json: { ok: true, assistant_message: { role: "assistant", content: "文字回复仍然可用。" }, state: { mind: { expression: "warm" } }, mode: "deepseek" } });
          if (path === "/api/digital-life/speech/synthesize") {
            if (mode === "tts") return route.fulfill({ status: 503, json: { ok: false, error: "speech_unavailable" } });
            return route.fulfill({ json: { ok: true, audio_base64: btoa("audio"), mime: "audio/mpeg" } });
          }
          return route.fulfill({ status: 404, json: { ok: false } });
        });

        await page.goto(`${baseUrl}${APP_PATH}`, { waitUntil: "networkidle" });
        await page.waitForFunction(() => window.DigitalLifeDeviceSimulator?.getState().speech.transcription === true);
        await page.locator("#micButton").click();
        if (mode === "microphone") {
          await page.locator("#interactionStatus", { hasText: "麦克风没有打开" }).waitFor();
          assert.equal(calls.filter(path => path.includes("/speech/transcribe")).length, 0);
          assert(await page.locator("#messageInput").isEnabled(), "text input should survive microphone denial");
          await page.close();
          continue;
        }
        await page.evaluate(() => {
          const samples = new Float32Array(1600);
          samples.fill(.2);
          window.__failureProcessor.onaudioprocess({ inputBuffer: { getChannelData: () => samples } });
        });
        await page.locator("#micButton").click();

        if (mode === "stt") {
          await page.locator("#interactionStatus", { hasText: "语音服务暂时不可用" }).waitFor();
          assert.equal(calls.filter(path => path === "/api/digital-life/message").length, 0);
          assert.equal(calls.filter(path => path.endsWith("/synthesize")).length, 0);
          assert(await page.locator("#messageInput").isEnabled(), "text input should survive STT failure");
        } else {
          await page.locator(".message-assistant", { hasText: "文字回复仍然可用。" }).waitFor();
          await page.waitForFunction(() => window.DigitalLifeDeviceSimulator.getState().expression === "warm");
          assert.equal(calls.filter(path => path === "/api/digital-life/message").length, 1);
          assert.equal(calls.filter(path => path.endsWith("/synthesize")).length, 1);
          if (mode === "autoplay") {
            assert(await page.locator("#replayAudio").isVisible(), "autoplay rejection should expose replay control");
          }
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, { dbPrefix: "vibeboard-market-failure-test", env: { DIGITAL_LIFE_AUTOSTART: "0" } });
}

async function runTickFlow() {
  await withServer(async ({ baseUrl }) => {
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
    let tickCalls = 0;
    let releaseHeldTick = null;
    try {
      await page.clock.install();
      await page.route("**/api/digital-life/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/digital-life/state") return route.fulfill({ json: { ok: true, state: { mood: "idle", mind: { expression: "idle" } } } });
        if (path === "/api/digital-life/memories") return route.fulfill({ json: { ok: true, memories: [] } });
        if (path === "/api/digital-life/messages") return route.fulfill({ json: { ok: true, messages: [] } });
        if (path === "/api/digital-life/speech/status") return route.fulfill({ json: { ok: true, configured: false, transcription: false, synthesis: false } });
        if (path === "/api/digital-life/tick") {
          tickCalls += 1;
          if (tickCalls === 2) await new Promise(resolve => { releaseHeldTick = resolve; });
          return route.fulfill({ json: { ok: true, state: { mood: `tick-${tickCalls}`, mind: { expression: tickCalls >= 3 ? "happy" : "curious" } } } });
        }
        return route.fulfill({ status: 404, json: { ok: false } });
      });
      await page.goto(`${baseUrl}${APP_PATH}`, { waitUntil: "networkidle" });
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator?.getState().connection_mode === "online");

      await page.clock.fastForward(60000);
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator.getState().last_tick_at !== "");
      assert.equal(tickCalls, 1);
      await page.clock.fastForward(60000);
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator.getState().tick_in_flight === true);
      await page.clock.fastForward(120000);
      assert.equal(tickCalls, 2, "tick requests should not overlap while one is in flight");
      releaseHeldTick();
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator.getState().tick_in_flight === false);

      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.clock.fastForward(300000);
      assert.equal(tickCalls, 2, "hidden pages should not tick");
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction(() => window.DigitalLifeDeviceSimulator.getState().expression === "happy");
      assert.equal(tickCalls, 3, "visibility restore should issue one catch-up tick");
    } finally {
      await browser.close();
    }
  }, { dbPrefix: "vibeboard-market-tick-test", env: { DIGITAL_LIFE_AUTOSTART: "0" } });
}

const section = process.argv.find(value => value.startsWith("--section="))?.split("=")[1] || "all";
if (section === "all" || section === "text") await runTextHydration();
if (section === "all" || section === "voice") await runVoiceFlow();
if (section === "all" || section === "failures") await runFailureModes();
if (section === "all" || section === "tick") await runTickFlow();
console.log(`PASS market companion ${section}`);
