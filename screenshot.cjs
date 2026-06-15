const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2] || 'http://127.0.0.1:8789/generated/current/index.html';
  const outPath = process.argv[3] || 'preview.png';
  const reportPath = process.argv[4] || ''; // optional: path to write JSON report

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let isBlank = false;
  let loadSuccess = false;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 480, height: 360 });

  // Capture console messages
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      const locationUrl = msg.location().url || '';
      const isOfflineHardwareProbe =
        text.includes('/api/status') ||
        text.includes('hardware-result.json') ||
        locationUrl.includes('/api/status') ||
        locationUrl.includes('hardware-result.json');
      if (!isOfflineHardwareProbe) consoleErrors.push(text);
    }
    if (msg.type() === 'warning') consoleWarnings.push(msg.text());
  });

  // Capture uncaught JS errors
  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    loadSuccess = true;

    // Wait for JS to execute
    await page.waitForTimeout(2000);

    // Check for blank screen: sample center pixel
    const pixel = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d');
      // Check if there's any visible content
      const body = document.body;
      const html = document.documentElement;
      const height = Math.max(
        body.scrollHeight, body.offsetHeight,
        html.clientHeight, html.scrollHeight, html.offsetHeight
      );
      // Check text content length
      const textLen = body.innerText?.trim().length || 0;
      // Check element count
      const elemCount = body.querySelectorAll('*').length;
      // Sample some visible elements
      const hasVisible = body.querySelectorAll('h1,h2,h3,p,span,strong,canvas,svg,button,div').length;
      return { height, textLen, elemCount, hasVisible };
    });

    // Heuristic: blank if no text and very few elements
    if (pixel.textLen < 5 && pixel.hasVisible < 2) {
      isBlank = true;
    }

    await page.screenshot({ path: outPath, type: 'png' });
    console.log('Screenshot saved: ' + outPath);
  } catch (err) {
    pageErrors.push(err.message);
  }

  await browser.close();

  // Build report
  const report = {
    ok: loadSuccess && !isBlank && pageErrors.length === 0 && consoleErrors.length === 0,
    screenshot: outPath,
    loadSuccess,
    isBlank,
    consoleErrors,
    consoleWarnings,
    pageErrors,
    timestamp: new Date().toISOString()
  };

  // Write report to file if path specified
  if (reportPath) {
    const fs = require('fs');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  }

  // Always output report to stdout
  console.log('__REPORT__' + JSON.stringify(report));

  if (!report.ok) {
    process.exit(1);
  }
})().catch(e => {
  console.error('Screenshot fatal:', e.message);
  console.log('__REPORT__' + JSON.stringify({
    ok: false,
    loadSuccess: false,
    isBlank: false,
    consoleErrors: [],
    pageErrors: [e.message],
    timestamp: new Date().toISOString()
  }));
  process.exit(1);
});
