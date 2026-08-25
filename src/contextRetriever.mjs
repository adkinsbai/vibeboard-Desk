const SOURCE_GROUPS = {
  projectMemory: 0,
  recentMessages: 1,
  fileSummaries: 2,
  assetSummaries: 2,
  preferences: 3,
  experiences: 4,
  playbooks: 5,
};

const SOURCE_ORDER = ["projectMemory", "recentMessages", "fileSummaries", "assetSummaries", "preferences", "experiences", "playbooks"];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value, fallback = "") {
  const text = value == null ? "" : String(value).trim();
  return text || fallback;
}

function normalizeInput(input = {}) {
  return {
    organizationId: normalizeText(input.organizationId || input.organization_id),
    actorId: normalizeText(input.actorId || input.actor_id),
    projectId: normalizeText(input.projectId || input.project_id),
    conversationId: normalizeText(input.conversationId || input.conversation_id),
    query: normalizeText(input.query),
    mode: normalizeText(input.mode, "general"),
    limit: clamp(Math.trunc(Number(input.limit || 10) || 10), 1, 50),
  };
}

function tokenize(value) {
  const text = normalizeText(value).toLowerCase();
  if (!text) return [];

  // Keep Latin words intact and add CJK unigrams/bigrams so Chinese project
  // memory remains searchable without introducing a heavyweight tokenizer.
  const tokens = text.match(/[a-z0-9]+|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/gi) || [];
  const output = [];
  for (const token of tokens) {
    if (/^[a-z0-9]+$/i.test(token)) {
      output.push(token);
      continue;
    }
    const chars = Array.from(token);
    output.push(...chars);
    for (let index = 0; index < chars.length - 1; index += 1) {
      output.push(chars[index] + chars[index + 1]);
    }
  }
  return output;
}

function scoreText(query, content) {
  const queryTokens = new Set(tokenize(query));
  if (!queryTokens.size) return 0;
  const contentTokens = new Set(tokenize(content));
  if (!contentTokens.size) return 0;
  let overlap = 0;
  for (const token of queryTokens) if (contentTokens.has(token)) overlap += 1;
  const phraseBoost = normalizeText(content).toLowerCase().includes(normalizeText(query).toLowerCase()) ? 0.25 : 0;
  return clamp(overlap / queryTokens.size + phraseBoost, 0, 1);
}

function toIso(value) {
  if (!value) return "";
  const text = String(value);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function normalizeScope(scope = {}) {
  if (!scope || typeof scope !== "object") return {};
  return {
    organizationId: normalizeText(scope.organizationId || scope.organization_id),
    actorId: normalizeText(scope.actorId || scope.actor_id),
    projectId: normalizeText(scope.projectId || scope.project_id),
    conversationId: normalizeText(scope.conversationId || scope.conversation_id),
    global: Boolean(scope.global || scope.isGlobal || scope.productWide),
  };
}

function canonicalScope(scope, input, source) {
  if (scope.global) return { global: true };
  const out = {};
  if (scope.organizationId || input.organizationId) out.organizationId = scope.organizationId || input.organizationId;
  if (scope.actorId || input.actorId) out.actorId = scope.actorId || input.actorId;
  if (scope.projectId || input.projectId) out.projectId = scope.projectId || input.projectId;
  if (scope.conversationId || input.conversationId) out.conversationId = scope.conversationId || input.conversationId;
  if (!Object.keys(out).length && source === "playbooks") return { global: true };
  return out;
}

function requiresProjectScope(source) {
  return source === "projectMemory" || source === "recentMessages" || source === "fileSummaries" || source === "assetSummaries" || source === "experiences";
}

function requiresConversationScope(source) {
  return source === "projectMemory" || source === "recentMessages";
}

function scopeMatches(entryScope = {}, input = {}, source) {
  const scope = normalizeScope(entryScope);
  if (scope.global) return source === "preferences" || source === "playbooks" || source === "experiences";
  if (source === "playbooks") return true;
  if (source === "preferences") {
    if (scope.organizationId && (!input.organizationId || scope.organizationId !== input.organizationId)) return false;
    if (scope.actorId && scope.actorId !== input.actorId) return false;
    if (scope.projectId && scope.projectId !== input.projectId) return false;
    return true;
  }
  // An explicit tenant scope must never be silently widened. When an older
  // local record has no organization id, project/conversation matching still
  // keeps it inside the requested project instead of dropping all legacy data.
  if (scope.organizationId && (!input.organizationId || scope.organizationId !== input.organizationId)) return false;
  if (requiresProjectScope(source) && !scope.projectId && !scope.conversationId) return false;
  if (scope.projectId && (!input.projectId || scope.projectId !== input.projectId)) return false;
  if (scope.conversationId && (!input.conversationId || scope.conversationId !== input.conversationId)) return false;
  if (scope.actorId && scope.actorId !== input.actorId) return false;
  return true;
}

function buildStructuredProjectContent(value = {}) {
  if (!value || typeof value !== "object") return "";
  const parts = [];
  const summary = normalizeText(value.summary);
  const goal = normalizeText(value.goal);
  const buildPrompt = normalizeText(value.build_prompt || value.buildPrompt);
  const requirements = normalizeList(value.requirements);
  const constraints = normalizeList(value.constraints);
  const decisions = normalizeList(value.decisions);
  const openQuestions = normalizeList(value.open_questions || value.openQuestions);
  if (summary) parts.push("Summary: " + summary);
  if (goal) parts.push("Goal: " + goal);
  for (const item of requirements) parts.push("Requirement: " + item);
  for (const item of constraints) parts.push("Constraint: " + item);
  for (const item of decisions) parts.push("Decision: " + item);
  for (const item of openQuestions) parts.push("Open question: " + item);
  if (buildPrompt) parts.push("Build prompt: " + buildPrompt);
  return parts.join("\n");
}

function normalizeList(value) {
  const input = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  const seen = new Set();
  for (const item of input.flat()) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function defaultConfidence(source) {
  if (source === "projectMemory") return 0.99;
  if (source === "recentMessages") return 0.7;
  if (source === "fileSummaries" || source === "assetSummaries") return 0.55;
  if (source === "preferences") return 0.4;
  if (source === "experiences") return 0.35;
  if (source === "playbooks") return 0.3;
  return 0.1;
}

function normalizeProvenance(provenance, source, sequence) {
  if (provenance && typeof provenance === "object") return provenance;
  if (provenance != null) return { value: provenance };
  return { source: source, sequence: sequence };
}

function buildFallbackContent(source, entry) {
  if (source === "projectMemory") return buildStructuredProjectContent(entry);
  if (!entry || typeof entry !== "object") return "";
  const parts = [];
  for (const key of ["title", "name", "label", "description", "summary"]) {
    if (entry[key]) parts.push(String(entry[key]));
  }
  return parts.join(" - ");
}

function hasStructuredProjectShape(value) {
  return ["summary", "goal", "requirements", "constraints", "decisions", "open_questions", "build_prompt", "buildPrompt"].some(function(key) {
    return value[key] != null;
  });
}

function expandProviderValue(source, value, input) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.entries)) return value.entries;
    if (source === "projectMemory" && hasStructuredProjectShape(value)) {
      return [{
        content: buildStructuredProjectContent(value),
        scope: value.scope || value.context || {
          organizationId: input.organizationId,
          projectId: input.projectId,
          conversationId: input.conversationId,
        },
        confidence: value.confidence,
        updated_at: value.updated_at || value.updatedAt || value.created_at || value.createdAt,
        provenance: value.provenance,
      }];
    }
    return [value];
  }
  return [value];
}

async function resolveProvider(deps, source, input) {
  const provider = deps[source] || (deps.providers && deps.providers[source]);
  if (!provider) return [];
  const value = typeof provider === "function" ? await provider(input) : provider;
  return expandProviderValue(source, value, input);
}

function normalizeEntry(entry, source, input, sequence) {
  if (entry == null) return null;
  if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
    entry = { content: entry };
  }
  const scope = normalizeScope(entry.scope || entry.context || {});
  const content = normalizeText(entry.content || entry.text || entry.summary || buildFallbackContent(source, entry));
  if (!content) return null;
  if (!scopeMatches(scope, input, source)) return null;
  return {
    source: source,
    scope: canonicalScope(scope, input, source),
    content: content,
    confidence: clamp(Number(entry.confidence ?? entry.score ?? defaultConfidence(source)), 0, 1),
    updated_at: toIso(entry.updated_at || entry.updatedAt || entry.created_at || entry.createdAt || ""),
    provenance: normalizeProvenance(entry.provenance, source, sequence),
    _sequence: sequence,
    _group: SOURCE_GROUPS[source] ?? 99,
    _relevance: scoreText(input.query, content),
  };
}

function compareIsoDesc(left, right) {
  const leftTime = Date.parse(left || "");
  const rightTime = Date.parse(right || "");
  const safeLeft = Number.isFinite(leftTime) ? leftTime : -Infinity;
  const safeRight = Number.isFinite(rightTime) ? rightTime : -Infinity;
  return safeRight - safeLeft;
}

function stripInternalFields(entry) {
  const out = {};
  for (const key in entry) {
    if (key[0] === "_") continue;
    out[key] = entry[key];
  }
  return out;
}

function formatScope(scope = {}) {
  if (!scope || scope.global) return "global";
  const parts = [];
  if (scope.organizationId) parts.push("org:" + scope.organizationId);
  if (scope.actorId) parts.push("actor:" + scope.actorId);
  if (scope.projectId) parts.push("project:" + scope.projectId);
  if (scope.conversationId) parts.push("conversation:" + scope.conversationId);
  return parts.length ? parts.join(" ") : "unspecified";
}

function formatProvenance(provenance) {
  if (!provenance) return "unknown";
  if (typeof provenance === "string") return provenance;
  try {
    return JSON.stringify(provenance);
  } catch {
    return "unserializable";
  }
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "0.00";
}

export function createContextRetriever(deps = {}) {
  async function loadMemoryContext(input = {}) {
    const normalizedInput = normalizeInput(input);
    const collected = [];
    const availableLayers = [];
    const errors = [];
    let sequence = 0;

    for (const source of SOURCE_ORDER) {
      try {
        const rawEntries = await resolveProvider(deps, source, normalizedInput);
        const normalized = [];
        for (const rawEntry of rawEntries) {
          const entry = normalizeEntry(rawEntry, source, normalizedInput, sequence);
          sequence += 1;
          if (entry) normalized.push(entry);
        }
        if (normalized.length) {
          availableLayers.push(source);
          collected.push(...normalized);
        }
      } catch (error) {
        errors.push({ source: source, message: error && error.message ? error.message : String(error) });
      }
    }

    collected.sort(function(left, right) {
      return (
        left._group - right._group ||
        right._relevance - left._relevance ||
        right.confidence - left.confidence ||
        compareIsoDesc(left.updated_at, right.updated_at) ||
        left._sequence - right._sequence
      );
    });

    return {
      input: normalizedInput,
      entries: collected.slice(0, normalizedInput.limit).map(stripInternalFields),
      degraded: errors.length > 0,
      availableLayers: availableLayers,
      errors: errors,
    };
  }

  function formatMemoryContext(result = {}) {
    const lines = [];
    const entries = Array.isArray(result.entries) ? result.entries : [];

    lines.push("Memory context");
    if (result.input && result.input.query) lines.push("query: " + result.input.query);
    if (result.input && result.input.mode) lines.push("mode: " + result.input.mode);
    lines.push("degraded: " + (result.degraded ? "true" : "false"));
    if (Array.isArray(result.availableLayers) && result.availableLayers.length) {
      lines.push("available_layers: " + result.availableLayers.join(", "));
    }
    if (Array.isArray(result.errors) && result.errors.length) {
      for (const error of result.errors) {
        lines.push("error: " + error.source + " - " + error.message);
      }
    }
    if (!entries.length) {
      lines.push("entries: []");
      return lines.join("\n");
    }

    lines.push("");
    entries.forEach(function(entry, index) {
      lines.push(
        (index + 1) + ". " + entry.source +
        " | scope=" + formatScope(entry.scope) +
        " | confidence=" + formatNumber(entry.confidence) +
        " | updated_at=" + (entry.updated_at || "")
      );
      lines.push("   provenance: " + formatProvenance(entry.provenance));
      lines.push("   content: " + entry.content);
    });
    return lines.join("\n");
  }

  return {
    loadMemoryContext: loadMemoryContext,
    formatMemoryContext: formatMemoryContext,
  };
}
