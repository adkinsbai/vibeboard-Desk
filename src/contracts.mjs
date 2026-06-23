import {
  ASSET_CONTRACT,
  validateAssetContracts,
} from "./assetContract.mjs";

export const GENERATED_FILES = Object.freeze([
  "index.html",
  "style.css",
  "app.js",
  "hardware_app.py",
  "manifest.json",
]);

export const HARDWARE_RESULT_FILE = "hardware-result.json";
export const GENERATED_WORKSPACE_DIR = "generated/current";
export const REQUIRED_RUNTIME_FILE_NAMES = Object.freeze(GENERATED_FILES.filter(name => name !== "manifest.json"));
export const AGENT_WRITABLE_FILE_NAMES = REQUIRED_RUNTIME_FILE_NAMES;
export const CONVERSATION_SNAPSHOT_FILE_NAMES = Object.freeze([
  ...GENERATED_FILES,
  HARDWARE_RESULT_FILE,
]);

export const REQUIRED_HARDWARE_RESULT_APIS = Object.freeze([
  "/api/status",
  `./${HARDWARE_RESULT_FILE}`,
]);

export const AUDIO_RUNTIME_APIS = Object.freeze([
  "/api/audio/status",
  "/api/audio/play",
  "/api/audio/record",
  "/api/audio/stop",
]);

export const REQUIRED_RUNTIME_APIS = Object.freeze([
  ...REQUIRED_HARDWARE_RESULT_APIS,
  ...AUDIO_RUNTIME_APIS,
]);

export const SCREEN_CONTRACT = Object.freeze({
  width: 480,
  height: 360,
  overflow: "hidden",
  theme: "dark",
  input: ["KEY1", "KEY2", "KEY3"],
  audio: ["speaker", "microphone"],
});

export const HARDWARE_PROFILE = Object.freeze({
  board: "Taishan Gray",
  chip: "RK3566",
  os: "Debian Linux",
  python: "3.x",
  staticTarget: "/home/linaro/workspace/taishan-screen/static",
  service: "taishan-screen.service",
  input: ["KEY1", "KEY2", "KEY3"],
  touch: false,
  audio: {
    playback: "aplay",
    recording: "arecord",
    api: [...AUDIO_RUNTIME_APIS],
  },
});

export const HARDWARE_APP_CONTRACT = Object.freeze({
  generatedFiles: GENERATED_FILES,
  runtimeFiles: REQUIRED_RUNTIME_FILE_NAMES,
  writableFiles: AGENT_WRITABLE_FILE_NAMES,
  snapshotFiles: CONVERSATION_SNAPSHOT_FILE_NAMES,
  hardwareResultFile: HARDWARE_RESULT_FILE,
  generatedWorkspaceDir: GENERATED_WORKSPACE_DIR,
  requiredHardwareResultApis: REQUIRED_HARDWARE_RESULT_APIS,
  requiredRuntimeApis: REQUIRED_RUNTIME_APIS,
  screen: SCREEN_CONTRACT,
  hardware: HARDWARE_PROFILE,
  assets: ASSET_CONTRACT,
});

export const APP_CONTRACT_SNIPPETS = Object.freeze([
  { text: "BUILD_ID", code: "APP_BUILD_ID", message: "app.js must define BUILD_ID." },
  { text: "PROMPT", code: "APP_PROMPT", message: "app.js must define PROMPT." },
  { text: "window.VibeBoardHardware", code: "APP_HARDWARE_API", message: "app.js must define window.VibeBoardHardware." },
  { text: "/api/status", code: "APP_STATUS_FETCH", message: "app.js must fetch /api/status." },
  { text: "hardware-result.json", code: "APP_PROGRAM_FETCH", message: "app.js must fetch ./hardware-result.json." },
]);

export const HARDWARE_CONTRACT_SNIPPETS = Object.freeze([
  { text: "available_apis", code: "HW_AVAILABLE_APIS", message: "hardware_app.py must declare available_apis." },
  { text: "/api/status", code: "HW_STATUS_API", message: "hardware_app.py available_apis must include /api/status." },
  { text: "hardware-result.json", code: "HW_PROGRAM_API", message: "hardware_app.py available_apis must include hardware-result.json." },
  { text: "build_id", code: "HW_BUILD_ID", message: "hardware_app.py JSON must include build_id." },
  { text: "runtime", code: "HW_RUNTIME", message: "hardware_app.py JSON must include runtime." },
]);

export const AGENT_VALIDATION_RULES = Object.freeze([
  "index.html must use relative ./style.css and ./app.js references.",
  `html, body, and the primary screen root must be designed for ${SCREEN_CONTRACT.width}px by ${SCREEN_CONTRACT.height}px with overflow hidden.`,
  "Do not use external CSS/JS libraries, CDNs, or emoji icons.",
  "Optional assets must live under assets/, use passive resource extensions only, and be declared in manifest.json assets[].",
  "app.js must define const BUILD_ID, const PROMPT, and window.VibeBoardHardware.",
  "window.VibeBoardHardware must provide getStatus(), getProgramResult(), and getSnapshot().",
  `app.js must fetch /api/status for hardware state and ./${HARDWARE_RESULT_FILE} for program output.`,
  "hardware_app.py must be valid Python 3 and define BUILD_ID, PROMPT, and available_apis.",
  "hardware_app.py must print JSON to stdout with runtime and build_id.",
  `hardware_app.py JSON available_apis must include ${REQUIRED_HARDWARE_RESULT_APIS.join(" and ")}.`,
  `local build must produce ${GENERATED_WORKSPACE_DIR}/${HARDWARE_RESULT_FILE}.`,
  `The visual design must be stable on a real ${SCREEN_CONTRACT.width}x${SCREEN_CONTRACT.height} dark-theme LCD with no overflow.`,
]);

export const VERIFICATION_LEVELS = Object.freeze({
  L0_CONTRACT: "L0_CONTRACT",
  L1_SYNTAX: "L1_SYNTAX",
  L2_HARDWARE_SIM: "L2_HARDWARE_SIM",
  L3_RENDER: "L3_RENDER",
  L4_BOARD: "L4_BOARD",
});

export function validationRulesText(language = "zh") {
  if (language === "zh") {
    return [
      "index.html 必须使用相对路径引用 ./style.css 和 ./app.js。",
      `html、body 和主屏幕根节点必须按 ${SCREEN_CONTRACT.width}px x ${SCREEN_CONTRACT.height}px 设计，overflow hidden。`,
      "禁止外部 CSS/JS 库、CDN 和 emoji 图标。",
      "app.js 必须定义 const BUILD_ID、const PROMPT 和 window.VibeBoardHardware。",
      "window.VibeBoardHardware 必须提供 getStatus()、getProgramResult()、getSnapshot()。",
      `app.js 必须 fetch /api/status 和 ./${HARDWARE_RESULT_FILE}。`,
      "hardware_app.py 必须是 Python 3，声明 BUILD_ID、PROMPT、available_apis。",
      "hardware_app.py 必须 print JSON 到 stdout，包含 runtime 和 build_id。",
      `hardware_app.py JSON available_apis 必须包含 ${REQUIRED_HARDWARE_RESULT_APIS.join(" 和 ")}。`,
      `本地 build 必须生成 ${GENERATED_WORKSPACE_DIR}/${HARDWARE_RESULT_FILE}。`,
      `设计必须适配真实 ${SCREEN_CONTRACT.width}x${SCREEN_CONTRACT.height} 深色小屏，无滚动和明显溢出。`,
    ];
  }
  return [...AGENT_VALIDATION_RULES];
}

export function hardwareContractPromptText(language = "zh") {
  if (language === "zh") {
    return [
      `硬件: ${HARDWARE_PROFILE.board}, ${HARDWARE_PROFILE.chip}, ${HARDWARE_PROFILE.os}, Python ${HARDWARE_PROFILE.python}`,
      `屏幕: ${SCREEN_CONTRACT.width}x${SCREEN_CONTRACT.height}, 无触摸, overflow ${SCREEN_CONTRACT.overflow}`,
      `输入: ${SCREEN_CONTRACT.input.join(", ")} 物理按键`,
      `输出/运行时数据: ${REQUIRED_RUNTIME_APIS.join(", ")}`,
      `生成文件: ${GENERATED_FILES.join(", ")}`,
      `生成阶段可写文件: ${AGENT_WRITABLE_FILE_NAMES.join(", ")}`,
      `硬件结果文件: ${GENERATED_WORKSPACE_DIR}/${HARDWARE_RESULT_FILE}`,
    ].join("\n");
  }

  return [
    `Hardware: ${HARDWARE_PROFILE.board}, ${HARDWARE_PROFILE.chip}, ${HARDWARE_PROFILE.os}, Python ${HARDWARE_PROFILE.python}`,
    `Screen: ${SCREEN_CONTRACT.width}x${SCREEN_CONTRACT.height}, no touch, overflow ${SCREEN_CONTRACT.overflow}`,
    `Input: ${SCREEN_CONTRACT.input.join(", ")} physical buttons`,
    `Runtime data: ${REQUIRED_RUNTIME_APIS.join(", ")}`,
    `Generated files: ${GENERATED_FILES.join(", ")}`,
    `Optional assets: ${ASSET_CONTRACT.directory}/ only, declared in manifest.json assets[], no HTML/JS/CSS/EXE.`,
    `Writable during generation: ${AGENT_WRITABLE_FILE_NAMES.join(", ")}`,
    `Hardware result: ${GENERATED_WORKSPACE_DIR}/${HARDWARE_RESULT_FILE}`,
  ].join("\n");
}

export function mergeRuntimeApis(apis = []) {
  return [...new Set([
    ...arrayOfStrings(apis),
    ...REQUIRED_RUNTIME_APIS,
  ])];
}

export function validateHardwareResultContract(result, {
  label = "hardware_app.py JSON output",
  expectedBuildId = "",
} = {}) {
  const issues = [];
  const value = result && typeof result === "object" ? result : {};
  if (!hasText(value.build_id)) {
    issues.push({
      code: "HARDWARE_BUILD_ID_MISSING",
      message: `${label} must include build_id.`,
      phase: "hardware_result",
      evidence: { outputKeys: Object.keys(value) },
    });
  }
  if (expectedBuildId && value.build_id !== expectedBuildId) {
    issues.push({
      code: "HARDWARE_BUILD_ID_MISMATCH",
      message: `${label} build_id mismatch: ${value.build_id || "(missing)"} !== ${expectedBuildId}.`,
      phase: "hardware_result",
      evidence: { actual: value.build_id, expected: expectedBuildId },
    });
  }
  if (!hasText(value.runtime)) {
    issues.push({
      code: "HARDWARE_RUNTIME_MISSING",
      message: `${label} must include runtime.`,
      phase: "hardware_result",
      evidence: { outputKeys: Object.keys(value) },
    });
  }
  const apis = Array.isArray(value.available_apis) ? value.available_apis.map(String) : [];
  for (const api of REQUIRED_HARDWARE_RESULT_APIS) {
    if (!hasRuntimeApi(apis, api)) {
      issues.push({
        code: api.includes(HARDWARE_RESULT_FILE) ? "HARDWARE_RESULT_API_MISSING" : "HARDWARE_STATUS_API_MISSING",
        message: `${label} available_apis must include ${api}.`,
        phase: "hardware_result",
        evidence: { available_apis: value.available_apis },
      });
    }
  }
  return issues;
}

export function validateFileContracts(files, label = "Generated app") {
  const issues = [];
  const appSource = files["app.js"] || "";
  const indexSource = files["index.html"] || "";
  const hardwareSource = files["hardware_app.py"] || "";

  for (const rule of APP_CONTRACT_SNIPPETS) {
    if (!appSource.includes(rule.text)) {
      issues.push({ code: rule.code, message: `${label} ${rule.message}`, phase: "contract" });
    }
  }
  for (const method of ["getStatus", "getProgramResult", "getSnapshot"]) {
    if (!appSource.includes(method)) {
      issues.push({
        code: `APP_METHOD_${method.toUpperCase()}`,
        message: `${label} window.VibeBoardHardware must include ${method}().`,
        phase: "contract",
      });
    }
  }
  if (!indexSource.includes("./style.css") || !indexSource.includes("./app.js")) {
    issues.push({
      code: "INDEX_RELATIVE_ASSETS",
      message: `${label} index.html must use relative ./style.css and ./app.js assets.`,
      phase: "contract",
    });
  }
  if (hasExternalAssetReference(indexSource) || hasExternalAssetReference(files["style.css"] || "")) {
    issues.push({
      code: "EXTERNAL_ASSET_REFERENCE",
      message: `${label} must not load external CSS/JS libraries or CDN assets.`,
      phase: "contract",
    });
  }
  for (const rule of HARDWARE_CONTRACT_SNIPPETS) {
    if (!hardwareSource.includes(rule.text)) {
      issues.push({ code: rule.code, message: `${label} ${rule.message}`, phase: "contract" });
    }
  }
  if (!hardwareSource.includes("print(") || !hardwareSource.includes("json.dumps")) {
    issues.push({
      code: "HW_JSON_STDOUT",
      message: `${label} hardware_app.py must print json.dumps(...) to stdout.`,
      phase: "contract",
    });
  }
  issues.push(...validateAssetContracts(files, {
    label,
    generatedFileNames: GENERATED_FILES,
    extraAllowedFileNames: [HARDWARE_RESULT_FILE],
  }));

  return issues;
}

export function assertFileContracts(files, label = "Generated app") {
  const issues = validateFileContracts(files, label);
  if (issues.length) {
    const error = new Error(issues.map(issue => issue.message).join(" "));
    error.issues = issues;
    throw error;
  }
}

export function createBuildEvidence({ id, source = "", verification = null, mode = "local" } = {}) {
  return {
    id,
    mode,
    source,
    verification,
    runtimeApis: [...REQUIRED_RUNTIME_APIS],
    screen: SCREEN_CONTRACT,
    createdAt: new Date().toISOString(),
  };
}

function hasRuntimeApi(apis, required) {
  if (apis.includes(required)) return true;
  if (required.includes(HARDWARE_RESULT_FILE)) {
    return apis.some(api => api.includes(HARDWARE_RESULT_FILE));
  }
  return false;
}

function hasText(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || "").trim()).filter(Boolean);
}

function hasExternalAssetReference(source = "") {
  const text = String(source || "");
  return /<(?:script|link)\b[^>]+(?:src|href)=["']https?:\/\//i.test(text)
    || /@import\s+(?:url\()?["']?https?:\/\//i.test(text)
    || /https?:\/\/[^"'\s>]*(?:cdn|unpkg|jsdelivr|cdnjs)[^"'\s>]*/i.test(text);
}
