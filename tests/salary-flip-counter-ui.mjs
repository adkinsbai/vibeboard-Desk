import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../market-apps/vb-salary-flip-counter/", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const app = await readFile(new URL("app.js", root), "utf8");
const css = await readFile(new URL("style.css", root), "utf8");
const kioskScript = await readFile(new URL("../runtime/start-kiosk.sh", import.meta.url), "utf8");

assert.match(html, /<script\s+defer\s+src=["']\.\/app\.js["']><\/script>/i);
assert.match(html, /日薪/);
assert.doesNotMatch(html, /时薪|¥9,000/);
assert.doesNotMatch(app, /per hour|hourlyRate|¥9,000/);
assert.doesNotMatch(html, /type=["']module["']/i);
assert.doesNotMatch(app, /^\s*(?:import|export)\b/m);
assert.doesNotMatch(app, /\bflap\b/i, "salary counter should not render layered half-digit flap elements on the RK3566 kiosk");
assert.doesNotMatch(css, /\.(?:flap)\b|flip-top|flip-bottom|backface-visibility|transform-style/i, "salary counter should avoid 3D half-flap CSS that leaves old/new digit halves overlapped on Chromium 91");
assert.match(css, /cursor:\s*none/i, "salary counter kiosk should hide the mouse cursor over the screen content");
assert.match(kioskScript, /hide_cursor\(\)/, "kiosk launcher should try to hide the X11 cursor before opening Chromium");
assert.match(kioskScript, /xsetroot\s+-cursor_name\s+none/, "kiosk launcher should hide the root cursor when xsetroot is available");
assert.match(kioskScript, /--start-fullscreen/, "kiosk launcher should force fullscreen in addition to Chromium kiosk mode");
console.log("salary-flip-counter-ui: classic deferred entrypoint is compatible with the board kiosk");
