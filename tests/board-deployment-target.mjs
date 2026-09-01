import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { boardConfigForBoundDevice, boardEndpoints, createBoardConfig, endpointLabel } from "../src/devices.mjs";
import { buildDeployRemoteCommand } from "../src/deskDeployer.mjs";
import { buildGoldenLoopRemoteCommand, buildGoldenLoopResult } from "../src/goldenLoop.mjs";

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

const defaults = createBoardConfig("taishan-gray", {});
assert.equal(defaults.user, "linaro");
assert.equal(defaults.kioskUrl, "http://127.0.0.1:8765/");
assert.equal(defaults.statusUrl, "http://127.0.0.1:8765/api/status");

const lanPreferred = createBoardConfig("taishan-gray", {
  VIBEBOARD_BOARD_HOST: "192.168.31.50",
  VIBEBOARD_BOARD_PORT: "22",
  VIBEBOARD_FRP_HOST: "150.158.146.192",
  VIBEBOARD_FRP_PORT: "6278",
});
assert.deepEqual(
  boardEndpoints(lanPreferred).map(endpointLabel),
  [
    "configured:192.168.31.50:22",
    "frp:150.158.146.192:6278",
  ],
  "deployment should try the configured/LAN route before FRP fallback",
);
assert.deepEqual(
  boardEndpoints({ ...lanPreferred, connectionMode: "preview" }),
  [],
  "preview-only devices should not silently deploy to the default gray board route",
);

const previewDeviceBoard = boardConfigForBoundDevice({
  board_id: "taishan-gray",
  label: "白色版小电脑",
  connection: { mode: "preview" },
}, {});
assert.equal(previewDeviceBoard.deployable, false);
assert.equal(previewDeviceBoard.host, "");
assert.equal(previewDeviceBoard.frpHost, "");
assert.deepEqual(boardEndpoints(previewDeviceBoard), []);

const lanDeviceBoard = boardConfigForBoundDevice({
  board_id: "taishan-gray",
  label: "LAN 灰色版",
  connection: {
    mode: "lan",
    host: "192.168.31.88",
    port: "22",
    user: "linaro",
  },
}, {
  VIBEBOARD_FRP_HOST: "150.158.146.192",
  VIBEBOARD_FRP_PORT: "6278",
});
assert.deepEqual(
  boardEndpoints(lanDeviceBoard).map(endpointLabel),
  [
    "configured:192.168.31.88:22",
    "frp:150.158.146.192:6278",
  ],
  "bound LAN devices should retain FRP as fallback without making FRP primary",
);

const custom = createBoardConfig("taishan-gray", {
  VIBEBOARD_KIOSK_URL: "http://127.0.0.1:8788/device",
  VIBEBOARD_BOARD_STATUS_URL: "http://127.0.0.1:8788/api/status",
});
assert.equal(custom.kioskUrl, "http://127.0.0.1:8788/device");
assert.equal(custom.statusUrl, "http://127.0.0.1:8788/api/status");

const board = {
  ...custom,
  releaseRoot: "/tmp/vibeboard/releases",
  backupRoot: "/tmp/vibeboard/backups",
  targetStatic: "/home/linaro/static",
  appRoot: "/home/linaro/app",
  service: "taishan-screen.service",
};
const deployCommand = buildDeployRemoteCommand({ board, buildId: "vb-target-check" });
assert.match(deployCommand, /TAISHAN_SCREEN_URL="\$kiosk_url"/);
assert.match(deployCommand, /curl -fsS "\$kiosk_url"/);
assert.match(deployCommand, /curl -fsS "\$status_url"/);
assert.match(deployCommand, /kiosk_url='http:\/\/127\.0\.0\.1:8788\/device'/);
assert.match(deployCommand, /status_url='http:\/\/127\.0\.0\.1:8788\/api\/status'/);

const goldenCommand = buildGoldenLoopRemoteCommand({
  targetStatic: board.targetStatic,
  service: board.service,
  kioskUrl: board.kioskUrl,
  statusUrl: board.statusUrl,
});
assert.match(goldenCommand, /curl -fsS "\$kiosk_url"/);
assert.match(goldenCommand, /curl -fsS "\$status_url"/);
assert.match(goldenCommand, /__SECTION__:kiosk_url/);

const expectedId = "vb-target-abcdef";
const golden = buildGoldenLoopResult({
  expectedId,
  sections: {
    service: "active",
    http_index_id: expectedId,
    static_index_id: expectedId,
    manifest: JSON.stringify({ id: expectedId }),
    program: JSON.stringify({ build_id: expectedId, runtime: "executed_on_board" }),
    status: JSON.stringify({ hostname: "taishan", services: { display: "active" } }),
    geometry: "Width: 480\nHeight: 360",
    kiosk_url: "http://127.0.0.1:8788/device",
    kiosk: "--window-size=480,360 --force-device-scale-factor=1",
  },
  kioskUrl: custom.kioskUrl,
  statusUrl: custom.statusUrl,
});
assert.equal(golden.ok, true, `configured golden loop should pass, got ${JSON.stringify(golden.checks)}`);

assert.doesNotMatch(
  serverSource,
  /endpoint:\s*\{\s*host:\s*BOARD\.frpHost,\s*port:\s*Number\(BOARD\.frpPort\)\s*\}/,
  "stdin upload must use the selected active endpoint instead of hard-coded FRP",
);
assert.doesNotMatch(
  serverSource,
  /ssh\("curl -fsS http:\/\/127\.0\.0\.1:8765\/api\/status"/,
  "board status checks must use BOARD.statusUrl instead of a hard-coded service URL",
);
assert.match(
  serverSource,
  /hasBoardCredentials\(resolvedBoard\)/,
  "deploy should evaluate credentials against the resolved request board",
);

console.log("board-deployment-target: configured kiosk and status routes stay aligned");
