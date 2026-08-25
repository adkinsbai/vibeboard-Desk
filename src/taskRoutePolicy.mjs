export const TASK_ROUTE_SCHEMA_VERSION = "task-route.v1";

export const taskRouteRoutes = Object.freeze({
  fast_patch: "fast_patch",
  guided_build: "guided_build",
  full_agent: "full_agent",
  clarify_or_block: "clarify_or_block",
});

export const TASK_ROUTES = Object.freeze({
  FAST_PATCH: taskRouteRoutes.fast_patch,
  GUIDED_BUILD: taskRouteRoutes.guided_build,
  FULL_AGENT: taskRouteRoutes.full_agent,
  CLARIFY_OR_BLOCK: taskRouteRoutes.clarify_or_block,
});

export const fast_patch_max_model_turns = 4;
export const guided_build_max_model_turns = 8;
export const full_agent_max_model_turns = 12;
export const clarify_or_block_max_model_turns = 1;

export const fast_patch_max_verification_attempts = 1;
export const guided_build_max_verification_attempts = 2;
export const full_agent_max_verification_attempts = 3;
export const clarify_or_block_max_verification_attempts = 0;

export const fast_patch_repair_attempts = 0;
export const guided_build_repair_attempts = 1;
export const full_agent_repair_attempts = 2;
export const clarify_or_block_repair_attempts = 0;

export const TASK_ROUTE_THRESHOLDS = Object.freeze({
  FAST_PATCH_MAX: 20,
  GUIDED_BUILD_MAX: 49,
  FULL_AGENT_MIN: 50,
});

const HARD_GATE_PATTERNS = Object.freeze([
  { id: "hardware_or_deploy", pattern: /(?:hardware|mic|microphone|audio|ssh|deploy|deployment|publish|release|ota|device|board|board-side|真机|部署|麦克风|蓝牙|串口|灰色版)/i },
  { id: "permissions_or_auth", pattern: /(?:permission|permissions|auth|authentication|login|token|secret|credential|oauth|session|bound device|binding|绑定|登录|权限|凭证|令牌)/i },
  { id: "external_api", pattern: /(?:api|webhook|endpoint|third[- ]party|external service|openai|payment|creem|stripe|iflytek|call out|联网)/i },
  { id: "database_or_persistence", pattern: /(?:database|db|sqlite|postgres|sql|persist(?:ence)?|migrat(?:e|ion)|schema|table|snapshot|恢复|持久化)/i },
  { id: "destructive_operation", pattern: /(?:delete|drop|destroy|wipe|reset|truncate|overwrite|remove all|clear all|format)/i },
]);

const AMBIGUITY_PATTERNS = Object.freeze([
  /(?:previous one|that one|the same thing|whatever that was|fix it|do that|make it better)/i,
  /之前那个|上一个|那个|改好|随便|一样的/,
]);

const COSMETIC_PATTERNS = Object.freeze([
  /(?:title|heading|text color|color|font|margin|padding|button|copy|label|swap|replace)/i,
  /改成|颜色|标题|按钮|文案|边距|字体|文本|文字/,
]);

const CALENDAR_PATTERNS = Object.freeze([
  /(?:calendar|schedule|event|meeting|slot|agenda|week view|day view|month view)/i,
  /日历|日程|会议|排期|周视图|月视图|时间槽|事件/,
]);

const BROAD_SCOPE_PATTERNS = Object.freeze([
  /(?:refactor|architecture|workflow|integration|orchestrate|benchmark|multi step|multi-step|system wide)/i,
  /重构|架构|流程|集成|编排|基准/,
]);

const FILE_HINTS = Object.freeze({
  single_file: new Set(["index.html", "style.css", "app.js", "main.js", "index.js", "app.jsx", "app.ts", "app.tsx"]),
});

const CONCRETE_REQUEST_PATTERN = /(?:html|css|js|calendar|schedule|event|weather|clock|timer|game|music|audio|mic|microphone|api|deploy|hardware|device|board|screen|page|view|table|form|dialog|app|application|小屏|应用|日历|日程|天气|时钟|计时|游戏|音乐|麦克风|蓝牙|部署|硬件|设备|页面|界面|表单|按钮|标题)/i;

export function scoreTaskRoute({ prompt = "", projectFiles = [], projectMemory = [], assets = [], action = "" } = {}) {
  const promptText = normalizeText(prompt);
  const fileNames = normalizeList(projectFiles);
  const fileCount = fileNames.length;
  const contextText = normalizeText([promptText, action].join(" "));
  // Existing runtime files describe the project surface, not the risk of the
  // current request. A previous hardware_app.py must not turn a CSS patch
  // into a full hardware task; only the current prompt/action can open a hard
  // gate, while the wider context contributes ordinary scope signals.
  const requestRiskText = normalizeText([promptText, action].join(" "));

  const hard_gates = collectHardGates(requestRiskText);
  const ambiguous = isAmbiguous(promptText, fileCount);
  const reasons = [];
  let score = 0;

  if (containsAny(promptText, COSMETIC_PATTERNS) && fileCount > 0 && fileCount <= 3) {
    score += 9;
    reasons.push("single_file_patch");
  }

  // A new project has no file evidence yet. Give it a bounded guided budget
  // instead of accidentally treating every first build as a fast patch.
  if (fileCount === 0 && hasMeaningfulRequestLength(promptText) && !ambiguous && !containsAny(promptText, COSMETIC_PATTERNS)) {
    score += 24;
    reasons.push("new_project_surface");
  }

  if (hasFileHint(fileNames, FILE_HINTS.single_file)) {
    score += 4;
    reasons.push("single_file_hint");
  }

  const broaderThanCosmetic = /(?:layout|regression|test|bug|fix|overflow|布局|回归|测试|修复|溢出)/i.test(promptText);
  if ((!containsAny(promptText, COSMETIC_PATTERNS) || broaderThanCosmetic) && containsAny(contextText, CALENDAR_PATTERNS)) {
    score += 14;
    reasons.push("calendar");
  }

  if (fileCount >= 2) {
    score += Math.min(10, 2 + (fileCount - 2) * 2);
    reasons.push(fileCount >= 5 ? "multi_file_surface" : "multi_file_change");
  }

  if (containsAny(contextText, BROAD_SCOPE_PATTERNS)) {
    score += 15;
    reasons.push("broad_change");
  }

  if (hard_gates.length > 0) {
    score += 50;
    reasons.push(...hard_gates);
  }

  if (ambiguous) {
    reasons.push("ambiguous_request");
  }

  score = clampInt(score, 0, 100);
  const route = chooseRoute({ score, hard_gates, ambiguous, promptText, fileCount, forceClarify: ambiguous || isUnsupportedWithoutContext(promptText, fileCount) });
  const confidence = computeConfidence({ route, score, hard_gates, ambiguous, reasonsCount: reasons.length });

  return {
    schema_version: TASK_ROUTE_SCHEMA_VERSION,
    route,
    score,
    confidence,
    reasons: dedupe(reasons.length > 0 ? reasons : inferReasons({ route, hard_gates, ambiguous, score })),
    hard_gates: dedupe(hard_gates),
    prompt: promptText,
  };
}

export function classifyTaskRoute(scoreResult = {}) {
  if (!scoreResult || typeof scoreResult !== "object") {
    return {
      schema_version: TASK_ROUTE_SCHEMA_VERSION,
      route: taskRouteRoutes.clarify_or_block,
      score: 0,
      confidence: 0,
      reasons: ["invalid_score_result"],
      hard_gates: [],
    };
  }

  const score = clampInt(Number(scoreResult.score ?? 0) || 0, 0, 100);
  const hard_gates = Array.isArray(scoreResult.hard_gates) ? dedupe(scoreResult.hard_gates.map(String)) : [];
  const reasons = Array.isArray(scoreResult.reasons) ? dedupe(scoreResult.reasons.map(String)) : [];
  const promptText = normalizeText(scoreResult.prompt || "");
  const ambiguous = reasons.includes("ambiguous_request") || Boolean(scoreResult.ambiguous);
  const route = chooseRoute({ score, hard_gates, ambiguous, promptText, fileCount: Array.isArray(scoreResult.projectFiles) ? scoreResult.projectFiles.length : 0, forceClarify: ambiguous });

  return {
    schema_version: String(scoreResult.schema_version || TASK_ROUTE_SCHEMA_VERSION),
    route,
    score,
    confidence: clampFloat(Number(scoreResult.confidence ?? computeConfidence({ route, score, hard_gates, ambiguous, reasonsCount: reasons.length })) || 0, 0, 1),
    reasons: reasons.length > 0 ? reasons : inferReasons({ route, hard_gates, ambiguous, score }),
    hard_gates,
  };
}

export function routeToExecutionProfile(route, scoreResult = {}) {
  const normalized = classifyTaskRoute(scoreResult);
  const selectedRoute = normalizeRoute(route) || normalized.route;
  const effectiveRoute = normalizeRoute(selectedRoute) || taskRouteRoutes.clarify_or_block;
  const base = profileForRoute(effectiveRoute);
  const reasons = Array.isArray(scoreResult.reasons) && scoreResult.reasons.length > 0 ? dedupe(scoreResult.reasons.map(String)) : normalized.reasons;
  const hard_gates = Array.isArray(scoreResult.hard_gates) && scoreResult.hard_gates.length > 0 ? dedupe(scoreResult.hard_gates.map(String)) : normalized.hard_gates;

  return {
    schema_version: TASK_ROUTE_SCHEMA_VERSION,
    route: base.route,
    score: clampInt(Number(scoreResult.score ?? normalized.score ?? 0) || 0, 0, 100),
    confidence: clampFloat(Number(scoreResult.confidence ?? normalized.confidence ?? 0) || 0, 0, 1),
    reasons,
    hard_gates,
    max_model_turns: base.max_model_turns,
    max_verification_attempts: base.max_verification_attempts,
    repair_attempts: base.repair_attempts,
    requires_confirmation: base.requires_confirmation,
  };
}

function profileForRoute(route) {
  switch (route) {
    case taskRouteRoutes.fast_patch:
      return {
        route,
        max_model_turns: fast_patch_max_model_turns,
        max_verification_attempts: fast_patch_max_verification_attempts,
        repair_attempts: fast_patch_repair_attempts,
        requires_confirmation: true,
      };
    case taskRouteRoutes.guided_build:
      return {
        route,
        max_model_turns: guided_build_max_model_turns,
        max_verification_attempts: guided_build_max_verification_attempts,
        repair_attempts: guided_build_repair_attempts,
        requires_confirmation: true,
      };
    case taskRouteRoutes.full_agent:
      return {
        route,
        max_model_turns: full_agent_max_model_turns,
        max_verification_attempts: full_agent_max_verification_attempts,
        repair_attempts: full_agent_repair_attempts,
        requires_confirmation: true,
      };
    default:
      return {
        route: taskRouteRoutes.clarify_or_block,
        max_model_turns: clarify_or_block_max_model_turns,
        max_verification_attempts: clarify_or_block_max_verification_attempts,
        repair_attempts: clarify_or_block_repair_attempts,
        requires_confirmation: true,
      };
  }
}

function chooseRoute({ score, hard_gates, ambiguous, promptText, fileCount, forceClarify = false }) {
  if (forceClarify || ambiguous || (promptText && isUnsupportedWithoutContext(promptText, fileCount))) {
    return taskRouteRoutes.clarify_or_block;
  }
  if (hard_gates.length > 0) {
    return taskRouteRoutes.full_agent;
  }
  if (score <= TASK_ROUTE_THRESHOLDS.FAST_PATCH_MAX) {
    return taskRouteRoutes.fast_patch;
  }
  if (score <= TASK_ROUTE_THRESHOLDS.GUIDED_BUILD_MAX) {
    return taskRouteRoutes.guided_build;
  }
  return taskRouteRoutes.full_agent;
}

function collectHardGates(text) {
  const gates = [];
  for (const gate of HARD_GATE_PATTERNS) {
    if (gate.pattern.test(text)) gates.push(gate.id);
  }
  return gates;
}

function computeConfidence({ route, score, hard_gates, ambiguous, reasonsCount }) {
  if (route === taskRouteRoutes.clarify_or_block) {
    return clampFloat(ambiguous ? 0.18 : 0.12, 0, 1);
  }

  let base = route === taskRouteRoutes.fast_patch ? 0.84 : route === taskRouteRoutes.guided_build ? 0.72 : 0.68;
  if (score >= 50) base += 0.06;
  if (hard_gates.length > 0) base += 0.04;
  base -= Math.min(0.16, Math.max(0, reasonsCount - 1) * 0.025);
  if (ambiguous) base -= 0.3;
  return clampFloat(Number(base.toFixed(2)), 0, 1);
}

function inferReasons({ route, hard_gates, ambiguous, score }) {
  const reasons = [];
  if (hard_gates.length > 0) reasons.push(...hard_gates);
  if (ambiguous) reasons.push("ambiguous_request");
  if (route === taskRouteRoutes.fast_patch && score <= TASK_ROUTE_THRESHOLDS.FAST_PATCH_MAX) reasons.push("low_risk_patch");
  if (route === taskRouteRoutes.guided_build) reasons.push("moderate_scope");
  if (route === taskRouteRoutes.full_agent) reasons.push("high_risk_or_high_scope");
  if (route === taskRouteRoutes.clarify_or_block) reasons.push("insufficient_context");
  return dedupe(reasons);
}

function isAmbiguous(promptText, fileCount) {
  if (!promptText) return true;
  if (fileCount === 0 && promptText.length < 8 && !CONCRETE_REQUEST_PATTERN.test(promptText)) return true;
  // A concrete edit such as "把那个按钮改成蓝色" has enough local intent
  // when a project already exists. Reserve clarification for genuinely vague
  // requests rather than reacting to every Chinese demonstrative pronoun.
  if (fileCount > 0 && promptText.length >= 8 && containsAny(promptText, COSMETIC_PATTERNS)) return false;
  return AMBIGUITY_PATTERNS.some((pattern) => pattern.test(promptText));
}

function isUnsupportedWithoutContext(promptText, fileCount) {
  if (fileCount > 0) return false;
  const hasConcreteNoun = CONCRETE_REQUEST_PATTERN.test(promptText) || /(?:api|deploy|hardware)/i.test(promptText) || /部署|硬件/.test(promptText);
  return !hasConcreteNoun && promptText.length < 20;
}

function hasMeaningfulRequestLength(promptText) {
  const compact = String(promptText || "").replace(/[\s\p{P}\p{S}]+/gu, "");
  return Array.from(compact).length >= 4;
}

function hasFileHint(fileNames, hintSet) {
  return fileNames.some((name) => {
    const lower = String(name).toLowerCase();
    for (const hint of hintSet) {
      if (lower.includes(hint)) return true;
    }
    return false;
  });
}

function containsAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [normalizeText(value)].filter(Boolean);
  return value
    .map((item) => normalizeText(typeof item === "string" ? item : item && typeof item === "object" ? Object.values(item).join(" ") : String(item ?? "")))
    .filter(Boolean);
}

function normalizeRoute(value) {
  const candidate = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(taskRouteRoutes, candidate) ? taskRouteRoutes[candidate] : Object.values(taskRouteRoutes).includes(candidate) ? candidate : "";
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function clampInt(value, min, max) {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampFloat(value, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : 0));
}
