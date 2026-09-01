import path from "node:path";

import { declaredAssetPathsFromFiles } from "./assetContract.mjs";
import { GENERATED_FILES } from "./contracts.mjs";
import { makeCheck } from "./goldenLoop.mjs";
import { shQuote } from "./remoteRunner.mjs";

export const DEPLOY_FILE_NAMES = [...GENERATED_FILES];

export function deployFileNamesForBuild(currentBuild = {}) {
  return [
    ...DEPLOY_FILE_NAMES,
    ...declaredAssetPathsFromFiles(currentBuild.files || {}),
  ];
}

export function buildDeployPaths(board, buildId) {
  const release = `${board.releaseRoot}/${buildId}`;
  return {
    release,
    backup: `${board.backupRoot}/static-${buildId}`,
    compilePath: `${release}/compile.log`,
    programPath: `${release}/hardware-result.json`
  };
}

export function buildDeployUploadEntries({
  currentBuild,
  board,
  runtimeDir,
  fileNames = deployFileNamesForBuild(currentBuild)
}) {
  const { release } = buildDeployPaths(board, currentBuild.id);
  return [
    ...fileNames.map(name => ({
      localPath: path.join(currentBuild.dir, name),
      remotePath: `${release}/${name}`
    })),
    {
      localPath: path.join(runtimeDir, "start-kiosk.sh"),
      remotePath: `${board.appRoot}/start-kiosk.sh`,
      mode: "0755"
    }
  ];
}

export function buildDeployRemoteCommand({ board, buildId }) {
  const { release, backup } = buildDeployPaths(board, buildId);
  const kioskUrl = board.kioskUrl || "http://127.0.0.1:8765/";
  const statusUrl = board.statusUrl || "http://127.0.0.1:8765/api/status";
  return [
    "set -u",
    `target=${shQuote(board.targetStatic)}`,
    `release=${shQuote(release)}`,
    `backup=${shQuote(backup)}`,
    `app_root=${shQuote(board.appRoot)}`,
    `kiosk_url=${shQuote(kioskUrl)}`,
    `status_url=${shQuote(statusUrl)}`,
    "compile_log=\"$release/compile.log\"",
    "program_result=\"$release/hardware-result.json\"",
    "mkdir -p \"$backup\" || exit 10",
    "python3 -m py_compile \"$release/hardware_app.py\" >\"$compile_log\" 2>&1 || exit 16",
    "echo \"board py_compile ok: $release/hardware_app.py\" >>\"$compile_log\"",
    "VIBEBOARD_RUNTIME=executed_on_board python3 \"$release/hardware_app.py\" >\"$program_result\" 2>>\"$compile_log\" || exit 17",
    "echo \"board program executed: $program_result\" >>\"$compile_log\"",
    `grep -q '"runtime"' "$program_result" || python3 -c "import json,sys;p=sys.argv[1];d=json.load(open(p));d['runtime']='executed_on_board';d.setdefault('build_id','${buildId}');json.dump(d,open(p,'w'),indent=2)" "$program_result" && echo "injected runtime" >>"$compile_log" || echo "inject-failed" >>"$compile_log"`,
    "cp -a \"$target/.\" \"$backup/\" || exit 11",
    "cp \"$release/index.html\" \"$target/index.html\" || exit 12",
    "cp \"$release/style.css\" \"$target/style.css\" || exit 13",
    "cp \"$release/app.js\" \"$target/app.js\" || exit 14",
    "cp \"$release/manifest.json\" \"$target/manifest.json\" || exit 15",
    "cp \"$program_result\" \"$target/hardware-result.json\" || exit 18",
    "rm -rf \"$target/assets\" || exit 19",
    "if [ -d \"$release/assets\" ]; then mkdir -p \"$target/assets\" || exit 22; cp -a \"$release/assets/.\" \"$target/assets/\" || exit 23; fi",
    "chmod +x \"$app_root/start-kiosk.sh\" || exit 15",
    `sudo systemctl restart ${shQuote(board.service)} || exit 20`,
    "sleep 5",
    `state=$(systemctl is-active ${shQuote(board.service)} || true)`,
    "if [ \"$state\" != \"active\" ]; then systemctl status taishan-screen.service --no-pager || true; exit 21; fi",
    "pkill -9 chromium-bin 2>/dev/null || true",
    "pkill -9 chromium 2>/dev/null || true",
    "sleep 1",
    "nohup env TAISHAN_SCREEN_URL=\"$kiosk_url\" \"$app_root/start-kiosk.sh\" >/tmp/vibeboard-kiosk-reload-request.log 2>&1 </dev/null &",
    "sleep 5",
    "kiosk=$( { ps -C chromium -o pid=,args= 2>/dev/null; ps -C chromium-bin -o pid=,args= 2>/dev/null; } | head -n 1 || true )",
    "curl -fsS \"$kiosk_url\" >/tmp/vibeboard-deploy-check.html || exit 30",
    "curl -fsS \"$status_url\" >/tmp/vibeboard-deploy-status.json || exit 31",
    "printf 'service=%s\\nbackup=%s\\ncompile=%s\\nprogram=%s\\nkiosk_url=%s\\nstatus_url=%s\\nkiosk=%s\\n' \"$state\" \"$backup\" \"$compile_log\" \"$program_result\" \"$kiosk_url\" \"$status_url\" \"$kiosk\""
  ].join("\n");
}

export function parseDeployOutput(output) {
  return {
    backup: (String(output || "").match(/^backup=(.*)$/m) || [])[1] || ""
  };
}

export function buildPostDeployVerificationFailure({
  buildId,
  route = "",
  error,
  checkedAt = new Date().toISOString()
}) {
  return {
    id: buildId,
    ok: false,
    checkedAt,
    route,
    checks: [makeCheck("post-deploy-ssh", "post deploy verification connection", false, error?.message || error)],
    raw: {}
  };
}
