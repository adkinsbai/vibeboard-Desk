export const SEVERITY = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  BLOCKING: "blocking",
});

export function makeIssue({
  code,
  message,
  phase = "unknown",
  severity = SEVERITY.BLOCKING,
  evidence = {},
  suggestedFixes = [],
} = {}) {
  return {
    code: code || "UNKNOWN_ISSUE",
    message: message || "Unknown issue",
    phase,
    severity,
    evidence,
    suggestedFixes: Array.isArray(suggestedFixes) ? suggestedFixes : [String(suggestedFixes)],
  };
}

export function toolResult({
  ok = false,
  phase = "unknown",
  summary = "",
  issues = [],
  evidence = {},
  data = null,
  degraded = false,
} = {}) {
  const normalizedIssues = issues.map(issue => makeIssue({ phase, ...issue }));
  return {
    ok: Boolean(ok) && !normalizedIssues.some(issue => issue.severity === SEVERITY.BLOCKING),
    phase,
    summary: summary || (ok ? "ok" : "failed"),
    issues: normalizedIssues,
    evidence,
    data,
    degraded: Boolean(degraded),
    timestamp: new Date().toISOString(),
  };
}

export function okResult(phase, summary = "ok", extra = {}) {
  return toolResult({ ...extra, ok: true, phase, summary });
}

export function failResult(phase, summary = "failed", issues = [], extra = {}) {
  return toolResult({ ...extra, ok: false, phase, summary, issues });
}

export function warnResult(phase, summary = "warning", issues = [], extra = {}) {
  return toolResult({
    ...extra,
    ok: true,
    phase,
    summary,
    issues: issues.map(issue => ({ severity: SEVERITY.WARNING, ...issue })),
    degraded: true,
  });
}

export function mergeResults(phase, summary, results) {
  const issues = [];
  const evidence = {};
  const data = {};
  let degraded = false;

  for (const result of results.filter(Boolean)) {
    issues.push(...(result.issues || []));
    if (result.evidence) evidence[result.phase || `phase_${Object.keys(evidence).length}`] = result.evidence;
    if (result.data != null) data[result.phase || `phase_${Object.keys(data).length}`] = result.data;
    degraded = degraded || Boolean(result.degraded);
  }

  return toolResult({
    ok: !issues.some(issue => issue.severity === SEVERITY.BLOCKING),
    phase,
    summary,
    issues,
    evidence,
    data,
    degraded,
  });
}

export function resultToText(result) {
  if (!result) return "";
  const lines = [result.ok ? `OK ${result.phase}: ${result.summary}` : `FAIL ${result.phase}: ${result.summary}`];
  for (const issue of result.issues || []) {
    const marker = issue.severity === SEVERITY.BLOCKING ? "BLOCKING" : issue.severity.toUpperCase();
    lines.push(`- ${marker} ${issue.code}: ${issue.message}`);
    if (issue.suggestedFixes?.length) {
      lines.push(`  fix: ${issue.suggestedFixes.join("; ")}`);
    }
  }
  return lines.join("\n");
}

export function resultToLegacyText(result) {
  if (!result) return "";
  if (result.ok && !(result.issues || []).length) return `✅ ${result.summary}`;
  const lines = [];
  if (result.ok) lines.push(`✅ ${result.summary}`);
  for (const issue of result.issues || []) {
    const marker = issue.severity === SEVERITY.BLOCKING ? "❌" : "⚠️";
    lines.push(`${marker} ${issue.message}`);
    if (issue.suggestedFixes?.length) {
      lines.push(`  建议: ${issue.suggestedFixes.join("; ")}`);
    }
  }
  return lines.join("\n");
}

export function legacyTextHasBlockingIssue(text) {
  return String(text || "").includes("❌") || /\bFAIL\b|\bBLOCKING\b/i.test(String(text || ""));
}
