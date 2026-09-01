import { routeToExecutionProfile, taskRouteRoutes } from "./taskRoutePolicy.mjs";

const HARD_DEPENDENCY_TOOLS = new Set([
  "run_hardware",
  "ssh_exec",
  "deploy_to_device",
]);

const HARD_DEPENDENCY_PATTERNS = [
  /hardware_app\.py/i,
  /manifest\.json/i,
  /deploy(?:ment)?/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /microphone|mic|audio|bluetooth/i,
  /board|device/i,
  /permission|credential|token/i,
  /\bBLOCKED\b/i,
  /system-owned|cannot modify|not writable/i,
];

const ROUTE_RANK = Object.freeze({
  [taskRouteRoutes.clarify_or_block]: 0,
  [taskRouteRoutes.fast_patch]: 1,
  [taskRouteRoutes.guided_build]: 2,
  [taskRouteRoutes.full_agent]: 3,
});

export function detectRouteEscalation(input = {}) {
  const routeProfile = input.routeProfile && typeof input.routeProfile === "object" ? input.routeProfile : null;
  const currentRoute = normalizeRoute(routeProfile?.route);
  if (!currentRoute || currentRoute === taskRouteRoutes.clarify_or_block || currentRoute === taskRouteRoutes.full_agent) {
    return null;
  }

  const toolName = String(input.toolName || "").trim();
  const resultText = normalizeText([
    input.result,
    input.args?.path,
    input.args?.summary,
    input.args?.query,
  ].join(" "));
  const touchedFileCount = Math.max(0, Number(input.touchedFileCount || 0) || 0);
  const fileRevision = Math.max(0, Number(input.fileRevision || 0) || 0);

  if (HARD_DEPENDENCY_TOOLS.has(toolName) || HARD_DEPENDENCY_PATTERNS.some(pattern => pattern.test(resultText))) {
    return promoteRouteProfile(routeProfile, taskRouteRoutes.full_agent, "hard_dependency_discovered", {
      tool: toolName,
      result: resultText,
      touchedFileCount,
      fileRevision,
    });
  }

  if (currentRoute === taskRouteRoutes.fast_patch && touchedFileCount >= 5) {
    return promoteRouteProfile(routeProfile, taskRouteRoutes.full_agent, "multi_file_surface_discovered", {
      tool: toolName,
      touchedFileCount,
      fileRevision,
    });
  }

  if (currentRoute === taskRouteRoutes.fast_patch && touchedFileCount >= 3) {
    return promoteRouteProfile(routeProfile, taskRouteRoutes.guided_build, "multi_file_scope_discovered", {
      tool: toolName,
      touchedFileCount,
      fileRevision,
    });
  }

  if (currentRoute === taskRouteRoutes.guided_build && touchedFileCount >= 5) {
    return promoteRouteProfile(routeProfile, taskRouteRoutes.full_agent, "expanded_scope_discovered", {
      tool: toolName,
      touchedFileCount,
      fileRevision,
    });
  }

  return null;
}

export function promoteRouteProfile(routeProfile = null, targetRoute = taskRouteRoutes.full_agent, reason = "", detail = {}) {
  const current = routeProfile && typeof routeProfile === "object" ? routeProfile : {};
  const currentRoute = normalizeRoute(current.route);
  const nextRoute = normalizeRoute(targetRoute);
  if (!nextRoute || rank(nextRoute) <= rank(currentRoute)) {
    return null;
  }

  const reasons = uniqueStrings([
    ...(Array.isArray(current.reasons) ? current.reasons : []),
    reason,
  ]);
  const nextProfile = routeToExecutionProfile(nextRoute, {
    ...current,
    route: nextRoute,
    reasons,
  });

  return {
    profile: nextProfile,
    escalation: {
      schema_version: "task-route-escalation.v1",
      from_route: currentRoute,
      to_route: nextProfile.route,
      reason: String(reason || "route_promoted").trim(),
      tool: String(detail.tool || "").trim(),
      touched_file_count: Math.max(0, Number(detail.touchedFileCount || 0) || 0),
      file_revision: Math.max(0, Number(detail.fileRevision || 0) || 0),
      detail: compactDetail(detail),
    },
  };
}

function normalizeRoute(value = "") {
  const route = String(value || "").trim();
  return Object.prototype.hasOwnProperty.call(ROUTE_RANK, route) ? route : "";
}

function rank(route = "") {
  return ROUTE_RANK[normalizeRoute(route)] ?? -1;
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function compactDetail(detail = {}) {
  const output = {};
  for (const [key, value] of Object.entries(detail || {})) {
    if (value == null) continue;
    if (typeof value === "string") {
      output[key] = value.slice(0, 200);
    } else if (typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
    }
  }
  return output;
}

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}
