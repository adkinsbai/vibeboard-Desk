export const GENERATED_FILES = Object.freeze([
  "index.html",
  "style.css",
  "app.js",
  "hardware_app.py",
  "manifest.json",
]);

export const REQUIRED_RUNTIME_APIS = Object.freeze([
  "/api/status",
  "./hardware-result.json",
]);

export const SCREEN_CONTRACT = Object.freeze({
  width: 480,
  height: 360,
  overflow: "hidden",
  theme: "dark",
  input: ["KEY1", "KEY2", "KEY3"],
});

export const HARDWARE_PROFILE = Object.freeze({
  board: "Taishan Gray",
  chip: "RK3566",
  os: "Debian Linux",
  python: "3.x",
  staticTarget: "/home/linaro/workspace/taishan-screen/static",
  service: "taishan-screen.service",
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
  "html, body, and the primary screen root must be designed for 480px by 360px with overflow hidden.",
  "Do not use external CSS/JS libraries, CDNs, or emoji icons.",
  "app.js must define const BUILD_ID, const PROMPT, and window.VibeBoardHardware.",
  "window.VibeBoardHardware must provide getStatus(), getProgramResult(), and getSnapshot().",
  "app.js must fetch /api/status for hardware state and ./hardware-result.json for program output.",
  "hardware_app.py must be valid Python 3 and define BUILD_ID, PROMPT, and available_apis.",
  "hardware_app.py must print JSON to stdout with runtime and build_id.",
  "local build must produce generated/current/hardware-result.json.",
  "The visual design must be stable on a real 480x360 dark-theme LCD with no overflow.",
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
      "html、body 和主屏幕根节点必须按 480px x 360px 设计，overflow hidden。",
      "禁止外部 CSS/JS 库、CDN 和 emoji 图标。",
      "app.js 必须定义 const BUILD_ID、const PROMPT 和 window.VibeBoardHardware。",
      "window.VibeBoardHardware 必须提供 getStatus()、getProgramResult()、getSnapshot()。",
      "app.js 必须 fetch /api/status 和 ./hardware-result.json。",
      "hardware_app.py 必须是 Python 3，声明 BUILD_ID、PROMPT、available_apis。",
      "hardware_app.py 必须 print JSON 到 stdout，包含 runtime 和 build_id。",
      "本地 build 必须生成 generated/current/hardware-result.json。",
      "设计必须适配真实 480x360 深色小屏，无滚动和明显溢出。",
    ];
  }
  return [...AGENT_VALIDATION_RULES];
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
