import { HARDWARE_APP_CONTRACT } from "./contracts.mjs";

export function createBuildIntelligenceSummary({
  build = {},
  manifest = {},
  verification = {},
  hardwareResult = {},
  board = {},
  pythonBin = "",
} = {}) {
  const screen = HARDWARE_APP_CONTRACT.screen;
  const hardware = HARDWARE_APP_CONTRACT.hardware;
  const boardLabel = board.label || hardware.board;
  const targetStatic = board.targetStatic || manifest.target || hardware.staticTarget;
  const buildId = build.id || manifest.id || hardwareResult.build_id || "";
  const checks = buildHardwareChecks({ verification, hardwareResult, buildId, pythonBin });
  const failedChecks = checks.filter(check => check.status !== "passed");
  const confidence = verification?.ok && failedChecks.length === 0 ? "local_verified" : "needs_attention";
  const boardFit = [
    `${screen.width}x${screen.height} ${hardware.chip} display`,
    screen.touch ? "touch input" : `${hardware.input.join("/")} physical keys`,
    `runtime APIs: ${HARDWARE_APP_CONTRACT.requiredRuntimeApis.join(", ")}`,
  ];

  return {
    version: 1,
    buildId,
    confidence,
    board: {
      label: boardLabel,
      chip: hardware.chip,
      os: hardware.os,
      screen: {
        width: screen.width,
        height: screen.height,
        touch: Boolean(screen.touch),
        overflow: screen.overflow,
      },
      inputs: [...hardware.input],
      audio: { ...hardware.audio },
      targetStatic,
    },
    deviceFit: `Fits ${boardLabel}: ${screen.width}x${screen.height} screen, ${hardware.input.join("/")} physical keys, local ${hardware.python} hardware script.`,
    hardwareChecks: checks,
    verifiedArtifacts: [
      "index.html",
      "style.css",
      "app.js",
      "hardware_app.py",
      HARDWARE_APP_CONTRACT.hardwareResultFile,
    ],
    autoRepairs: [],
    boardFit,
    nextBestAction: confidence === "local_verified" ? "deploy_to_board" : "inspect_build_evidence",
    userMoment: confidence === "local_verified"
      ? `Generated app is locally verified for ${boardLabel}; hardware script ran and matched build ${buildId}.`
      : `Generated app needs attention before it is safe for ${boardLabel}.`,
  };
}

function buildHardwareChecks({ verification = {}, hardwareResult = {}, buildId = "", pythonBin = "" } = {}) {
  const evidence = verification?.evidence || {};
  const issues = Array.isArray(verification?.issues) ? verification.issues : [];
  const hasIssue = code => issues.some(issue => String(issue.code || "").includes(code));
  const availableApis = Array.isArray(hardwareResult.available_apis)
    ? hardwareResult.available_apis.map(String)
    : [];
  const requiredApis = HARDWARE_APP_CONTRACT.requiredHardwareResultApis;

  return [
    {
      id: "javascript_syntax",
      label: "JavaScript syntax",
      status: evidence.nodeCheck === "passed" || verification?.ok ? "passed" : "unknown",
      detail: "node --check app.js",
    },
    {
      id: "python_compile",
      label: "Python compile",
      status: evidence.pythonCompile === "passed" || verification?.ok ? "passed" : "unknown",
      detail: `${pythonBin || "python"} -m py_compile hardware_app.py`,
    },
    {
      id: "hardware_run",
      label: "Hardware script run",
      status: evidence.hardwareRun === "passed" || Boolean(hardwareResult.runtime) ? "passed" : "unknown",
      detail: hardwareResult.runtime || "hardware_app.py runtime output",
    },
    {
      id: "build_id_match",
      label: "Build id match",
      status: buildId && hardwareResult.build_id === buildId ? "passed" : "failed",
      detail: `${hardwareResult.build_id || "(missing)"} === ${buildId || "(missing)"}`,
    },
    {
      id: "runtime_apis",
      label: "Runtime APIs",
      status: requiredApis.every(api => availableApis.some(item => item === api || item.includes(api.replace("./", ""))))
        && !hasIssue("HARDWARE_STATUS_API_MISSING")
        && !hasIssue("HARDWARE_RESULT_API_MISSING")
        ? "passed"
        : "failed",
      detail: requiredApis.join(", "),
    },
    {
      id: "local_verify",
      label: "Local L0-L3 verification",
      status: verification?.ok ? "passed" : "failed",
      detail: verification?.summary || "local verification result",
    },
  ];
}
