const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2] || 'http://127.0.0.1:8789/generated/current/index.html';
  const outPath = process.argv[3] || 'preview.png';

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 480, height: 360 });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1500); // Wait for any animations
  await page.screenshot({ path: outPath, type: 'png' });
  await browser.close();
  console.log('Screenshot saved: ' + outPath);
})().catch(e => {
  console.error('Screenshot failed:', e.message);
  process.exit(1);
});
