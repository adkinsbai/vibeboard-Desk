import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const env = { ...process.env };
for (const name of [
  "VIBEBOARD_RUN_LIVE_SPEECH",
  "IFLYTEK_APP_ID",
  "IFLYTEK_API_KEY",
  "IFLYTEK_API_SECRET",
]) delete env[name];

const result = spawnSync(process.execPath, ["scripts/verify-digital-life-speech-live.mjs"], {
  cwd: new URL("..", import.meta.url),
  env,
  encoding: "utf8",
  windowsHide: true,
});

assert.notEqual(result.status, 0, "live verifier should refuse an ungated run");
assert.match(`${result.stdout}${result.stderr}`, /VIBEBOARD_RUN_LIVE_SPEECH=1/);
assert(!`${result.stdout}${result.stderr}`.match(/authorization=|wss:\/\//i));
console.log("PASS digital life speech live gate");
