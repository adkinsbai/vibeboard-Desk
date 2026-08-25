import { strict as assert } from "node:assert";
import { createToolExecutor } from "../src/agent.mjs";
import {
  calculateContractHash,
  filterDeployableFiles,
  validateDeployConfirmation,
} from "../src/hardwareContractFirewall.mjs";

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function makeFiles() {
  return {
    "index.html": "<!doctype html><html><head><link rel=\"stylesheet\" href=\"./style.css\"></head><body><script src=\"./app.js\"></script></body></html>",
    "style.css": "body { margin: 0; }",
    "app.js": "window.VibeBoardHardware = { async getStatus() {}, async getProgramResult() {}, getSnapshot() {} };",
    "hardware_app.py": "print('ok')",
    "manifest.json": JSON.stringify({ id: "vb-test", files: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"], assets: ["assets/logo.png"] }),
    "assets/logo.png": "binary",
    "notes.txt": "do not deploy",
  };
}

test("create and edit reject hardware_app.py but keep other writable files", async () => {
  const fileStore = { "app.js": "const answer = 1;", "hardware_app.py": "print('keep')" };
  const { executeTool } = createToolExecutor(fileStore);

  const createBlocked = await executeTool("create_file", { path: "hardware_app.py", content: "print('new')" });
  assert.match(createBlocked, /cannot create hardware_app\.py|不能创建 hardware_app\.py/);
  assert.equal(fileStore["hardware_app.py"], "print('keep')");

  const editBlocked = await executeTool("edit_file", {
    path: "hardware_app.py",
    old_text: "keep",
    new_text: "new",
  });
  assert.match(editBlocked, /cannot modify hardware_app\.py|不能修改 hardware_app\.py/);
  assert.equal(fileStore["hardware_app.py"], "print('keep')");

  const editAllowed = await executeTool("edit_file", {
    path: "app.js",
    old_text: "1",
    new_text: "2",
  });
  assert.match(editAllowed, /已编辑 app\.js/);
  assert.equal(fileStore["app.js"], "const answer = 2;");
});

test("filterDeployableFiles keeps only deployable runtime files and declared assets", () => {
  const files = makeFiles();
  const filtered = filterDeployableFiles(files, {
    generatedFileNames: ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"],
  });

  assert.deepEqual(Object.keys(filtered).sort(), [
    "app.js",
    "assets/logo.png",
    "hardware_app.py",
    "index.html",
    "manifest.json",
    "style.css",
  ]);
  assert.equal(filtered["notes.txt"], undefined);
});

test("validateDeployConfirmation rejects missing confirmation, unbound device, and hash mismatch", () => {
  const missingConfirmation = validateDeployConfirmation({
    deviceId: "taishan-gray-1",
    boundDeviceId: "taishan-gray-1",
    contractHash: "abc",
    expectedContractHash: "abc",
  });
  assert.equal(missingConfirmation.ok, false);
  assert(missingConfirmation.issues.some(issue => issue.code === "DEPLOY_CONFIRMATION_MISSING"));

  const unboundDevice = validateDeployConfirmation({
    confirmation: "deploy",
    deviceId: "taishan-gray-1",
    contractHash: "abc",
    expectedContractHash: "abc",
  });
  assert.equal(unboundDevice.ok, false);
  assert(unboundDevice.issues.some(issue => issue.code === "DEPLOY_DEVICE_UNBOUND"));

  const hashMismatch = validateDeployConfirmation({
    confirmation: "deploy",
    deviceId: "taishan-gray-1",
    boundDeviceId: "taishan-gray-1",
    contractHash: "abc",
    expectedContractHash: "def",
  });
  assert.equal(hashMismatch.ok, false);
  assert(hashMismatch.issues.some(issue => issue.code === "DEPLOY_CONTRACT_HASH_MISMATCH"));
});

test("calculateContractHash is stable and changes when a contract file changes", () => {
  const files = makeFiles();
  const first = calculateContractHash({ buildId: "vb-test", files });
  const second = calculateContractHash({ buildId: "vb-test", files: { ...files } });
  assert.equal(first, second);
  const changed = calculateContractHash({
    buildId: "vb-test",
    files: { ...files, "hardware_app.py": "print('changed')" },
  });
  assert.notEqual(changed, first);
});

test("deploy_to_device rejects missing confirmation and filters non-deployable files", async () => {
  const fileStore = makeFiles();
  const scpCalls = [];
  const sshCalls = [];
  const { executeTool } = createToolExecutor(fileStore, {
    ssh: async command => {
      sshCalls.push(command);
      return "";
    },
    scp: async (localFile, remoteDir) => {
      scpCalls.push({ localFile, remoteDir });
    },
  });

  const rejected = await executeTool("deploy_to_device", {});
  assert.match(rejected, /缺少部署确认|未绑定设备|契约哈希不匹配|confirmation/i);

  const accepted = await executeTool("deploy_to_device", {
    confirmation: {
      confirmation: "deploy",
      deviceId: "taishan-gray-1",
      boundDeviceId: "taishan-gray-1",
      contractHash: "abc",
      expectedContractHash: "abc",
    },
  });

  assert.match(accepted, /已部署|模拟部署模式/);
  assert.equal(scpCalls.some(call => /notes\.txt$/.test(call.localFile)), false);
  assert.equal(sshCalls.some(command => String(command).includes("notes.txt")), false);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log("PASS " + name);
  } catch (error) {
    failed += 1;
    console.error("FAIL " + name);
    console.error(error?.stack || error?.message || String(error));
  }
}

if (failed > 0) {
  process.exitCode = 1;
}
