import { chromium } from "playwright";
import { assert, withServer } from "./support/serverHarness.mjs";

const apps = {
  pet: "/market-apps/makivo-my-ai-pet/index.html",
  radio: "/market-apps/makivo-pixel-radio/index.html",
};

await withServer(async ({ baseUrl }) => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 480, height: 360 } });
  const forbiddenRequests = [];
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/**", route => {
    forbiddenRequests.push(route.request().url());
    return route.fulfill({
      status: 599,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, error: "offline_app_must_not_call_api" }),
    });
  });

  try {
    await page.goto(`${baseUrl}${apps.pet}`, { waitUntil: "networkidle" });
    await page.locator("#pet-screen").waitFor({ timeout: 6000 });
    const initialPet = await page.evaluate(() => window.MakivoPetSimulator?.getState?.());
    assert(initialPet?.connection_mode === "offline", "AI pet should run as a local deployable app");
    assert(initialPet?.input_mode === "voice-text-fallback", "AI pet should expose voice input with a text fallback");
    assert(initialPet?.pet?.stage === "ready", "AI pet should boot into the ready state");

    await page.locator("#voiceInput").fill("一只蓝色的会唱歌的小狐狸");
    await page.locator("#voiceForm").evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => window.MakivoPetSimulator.getState().pet.stage === "ready", null, { timeout: 6000 });
    const createdPet = await page.evaluate(() => window.MakivoPetSimulator.getState());
    assert(createdPet.pet.species === "fox", "AI pet should parse fox from a voice transcript");
    assert(createdPet.pet.color === "blue", "AI pet should parse blue from a voice transcript");
    assert(createdPet.pet.hobby === "singing", "AI pet should parse a hobby from a voice transcript");
    assert(createdPet.pet.stage === "ready", "AI pet should return to ready after hatching");
    assert(await documentHasText(page, "声音已变成一只新伙伴"), "AI pet should show the local hatch result");

    await page.goto(`${baseUrl}${apps.radio}`, { waitUntil: "networkidle" });
    await page.locator("#radio-screen").waitFor({ timeout: 6000 });
    const initialRadio = await page.evaluate(() => window.MakivoRadioSimulator?.getState?.());
    assert(initialRadio?.connection_mode === "offline", "Pixel Radio should run as a local deployable app");
    assert(initialRadio?.catalog_source === "bundled", "Pixel Radio should use a bundled preinstalled catalog");
    assert(initialRadio?.tracks?.length >= 4, "Pixel Radio should ship with a curated local track list");
    assert(initialRadio?.audio_source === "embedded-synth", "Pixel Radio should not depend on remote audio files");

    await page.locator("#playButton").click();
    await page.waitForFunction(() => window.MakivoRadioSimulator.getState().playing === true);
    const playingRadio = await page.evaluate(() => window.MakivoRadioSimulator.getState());
    assert(playingRadio.current_lyric, "Pixel Radio should expose the active lyric line while playing");

    const firstTrack = playingRadio.selected_track;
    await page.locator("#nextButton").click();
    const nextRadio = await page.evaluate(() => window.MakivoRadioSimulator.getState());
    assert(nextRadio.selected_track !== firstTrack, "Pixel Radio should switch to the next bundled track");
    assert(nextRadio.visualizer_frame > 0, "Pixel Radio should animate the visualizer after playback starts");

    const canvasPixel = await page.locator("#visualizer").evaluate(canvas => {
      const ctx = canvas.getContext("2d");
      return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data).some(value => value !== 0);
    });
    assert(canvasPixel, "Pixel Radio visualizer canvas should render non-empty pixels");
    assert(forbiddenRequests.length === 0, `offline apps must not call APIs: ${forbiddenRequests.join(", ")}`);
    assert(pageErrors.length === 0, `offline apps should not emit page errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
  }
}, { dbPrefix: "makivo-device-apps", wait: { path: "/api/health" } });

function documentHasText(page, text) {
  return page.locator("body").evaluate((body, expected) => body.textContent.includes(expected), text);
}

console.log("makivo-device-apps ok");
