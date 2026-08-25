import crypto from "node:crypto";

export function createAssetRelevanceIndex(db, saveDb = () => {}) {
  return {
    initSchema,
    isReady,
    upsert,
    remove,
    rebuild,
    searchRelevantAssets,
  };

  function isReady() {
    return querySafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('asset_relevance_docs', 'asset_relevance_terms')").length === 2;
  }

  function initSchema() {
    runTransaction(() => {
      db.run("CREATE TABLE IF NOT EXISTS asset_relevance_docs (asset_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', folder_id TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'unclassified', usage TEXT NOT NULL DEFAULT 'auto', normalized_text TEXT NOT NULL DEFAULT '', summary_hash TEXT NOT NULL DEFAULT '', build_last_used_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
      db.run("CREATE TABLE IF NOT EXISTS asset_relevance_terms (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, asset_id TEXT NOT NULL, term TEXT NOT NULL, facet TEXT NOT NULL, weight REAL NOT NULL DEFAULT 1)");
      db.run("CREATE INDEX IF NOT EXISTS idx_asset_relevance_docs_conversation_role ON asset_relevance_docs(conversation_id, role, usage, updated_at DESC)");
      db.run("CREATE INDEX IF NOT EXISTS idx_asset_relevance_docs_folder ON asset_relevance_docs(conversation_id, folder_id, updated_at DESC)");
      db.run("CREATE INDEX IF NOT EXISTS idx_asset_relevance_terms_lookup ON asset_relevance_terms(conversation_id, term, asset_id, facet)");
      db.run("CREATE INDEX IF NOT EXISTS idx_asset_relevance_terms_asset ON asset_relevance_terms(conversation_id, asset_id)");
      try {
        db.run("CREATE INDEX IF NOT EXISTS idx_asset_relevance_build_snapshots_lookup ON build_asset_snapshots(conversation_id, asset_id, created_at DESC)");
      } catch {}
    });
  }

  function upsert(assetInput = {}, options = {}) {
    try {
      initSchema();
      const asset = normalizeAssetInput(assetInput, options);
      if (!asset.asset_id || !asset.conversation_id) return null;
      runTransaction(() => writeAsset(asset, { save: false }));
      return getDoc(asset.conversation_id, asset.asset_id);
    } catch {
      return null;
    }
  }

  function remove(conversationId = "", assetId = "") {
    const scope = cleanId(conversationId);
    const id = cleanId(assetId);
    if (!id) return;
    try {
      initSchema();
      runTransaction(() => {
        if (scope) {
          db.run("DELETE FROM asset_relevance_terms WHERE conversation_id = ? AND asset_id = ?", [scope, id]);
          db.run("DELETE FROM asset_relevance_docs WHERE conversation_id = ? AND asset_id = ?", [scope, id]);
        } else {
          db.run("DELETE FROM asset_relevance_terms WHERE asset_id = ?", [id]);
          db.run("DELETE FROM asset_relevance_docs WHERE asset_id = ?", [id]);
        }
      });
    } catch {}
  }

  function rebuild(conversationId = "") {
    const scope = cleanId(conversationId);
    try {
      initSchema();
      const rows = readAssetLibraryRows(scope);
      runTransaction(() => {
        if (scope) {
          db.run("DELETE FROM asset_relevance_terms WHERE conversation_id = ?", [scope]);
          db.run("DELETE FROM asset_relevance_docs WHERE conversation_id = ?", [scope]);
        } else {
          db.run("DELETE FROM asset_relevance_terms");
          db.run("DELETE FROM asset_relevance_docs");
        }
        for (const row of rows) writeAsset(normalizeAssetInput(row), { save: false });
      });
      return rows.length;
    } catch {
      return 0;
    }
  }

  function searchRelevantAssets(conversationId = "", query = "", filters = {}) {
    const scope = cleanId(conversationId);
    if (!scope) return [];
    try {
      initSchema();
      backfillMissingDocs(scope);
      const docs = querySafe("SELECT * FROM asset_relevance_docs WHERE conversation_id = ? ORDER BY updated_at DESC, asset_id ASC", [scope]);
      if (!docs.length) return [];
      const terms = querySafe("SELECT asset_id, term, facet, weight FROM asset_relevance_terms WHERE conversation_id = ?", [scope]);
      const selected = new Set(normalizeList(filters.selectedAssetIds || filters.selected || []));
      const allowedRoles = resolveAllowedRoles(filters);
      const queryText = normalizeText(query);
      const queryTokens = new Set(tokenize(queryText));
      const termMap = groupTerms(terms);
      const limit = clampLimit(filters.limit);
      const results = [];
      for (const doc of docs) {
        const assetId = String(doc.asset_id || "");
        const isSelected = selected.has(assetId);
        if (!isSelected && !allowedRoles.has(String(doc.role || "unclassified"))) continue;
        if (!isSelected && !matchesFilters(doc, filters)) continue;
        const result = scoreDoc(doc, queryText, queryTokens, termMap.get(assetId) || [], isSelected);
        if (!isSelected && result.score <= 0 && queryTokens.size) continue;
        results.push(result);
      }
      results.sort(compareResults);
      const selectedResults = results.filter(item => item.selected);
      const otherResults = results.filter(item => !item.selected);
      const cappedOthers = otherResults.slice(0, limit);
      return [...selectedResults, ...cappedOthers].map(stripInternalFlags);
    } catch {
      return [];
    }
  }

  function backfillMissingDocs(scope) {
    const assets = readAssetLibraryRows(scope);
    if (!assets.length) return;
    const existing = new Set(querySafe("SELECT asset_id FROM asset_relevance_docs WHERE conversation_id = ?", [scope]).map(row => String(row.asset_id || "")));
    const missing = assets.filter(row => !existing.has(String(row.asset_id || "")));
    if (!missing.length) return;
    runTransaction(() => {
      for (const row of missing) writeAsset(normalizeAssetInput(row), { save: false });
    });
  }

  function writeAsset(asset, options = {}) {
    const summary = asset.summary;
    const buildLastUsedAt = asset.build_last_used_at || latestBuildUse(asset.conversation_id, asset.asset_id);
    const role = deriveRole(asset.usage, buildLastUsedAt);
    const normalizedText = buildNormalizedText(asset, summary, role, buildLastUsedAt);
    const summaryHash = sha256(canonicalJson(summary));
    const indexedAt = nowStamp();
    db.run("DELETE FROM asset_relevance_terms WHERE conversation_id = ? AND asset_id = ?", [asset.conversation_id, asset.asset_id]);
    db.run("INSERT INTO asset_relevance_docs (asset_id, conversation_id, name, kind, category, folder_id, role, usage, normalized_text, summary_hash, build_last_used_at, updated_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET conversation_id = excluded.conversation_id, name = excluded.name, kind = excluded.kind, category = excluded.category, folder_id = excluded.folder_id, role = excluded.role, usage = excluded.usage, normalized_text = excluded.normalized_text, summary_hash = excluded.summary_hash, build_last_used_at = excluded.build_last_used_at, updated_at = excluded.updated_at, indexed_at = excluded.indexed_at", [
      asset.asset_id,
      asset.conversation_id,
      asset.name,
      asset.kind,
      asset.category,
      asset.folder_id,
      role,
      asset.usage,
      normalizedText,
      summaryHash,
      buildLastUsedAt,
      asset.updated_at,
      indexedAt,
    ]);
    for (const term of buildTerms(asset, summary, role)) {
      db.run("INSERT INTO asset_relevance_terms (conversation_id, asset_id, term, facet, weight) VALUES (?, ?, ?, ?, ?)", [asset.conversation_id, asset.asset_id, term.term, term.facet, term.weight]);
    }
    if (options.save !== false) saveDb();
  }

  function scoreDoc(doc, queryText, queryTokens, terms, selected) {
    const matched = new Set();
    let score = 0;
    if (selected) {
      score += 1000;
      matched.add("selection");
    }
    const docText = String(doc.normalized_text || "");
    const nameText = normalizeText(doc.name || "");
    const nameTokens = new Set(tokenize(nameText));
    let nameHits = 0;
    for (const token of queryTokens) {
      if (nameTokens.has(token)) {
        score += 50;
        nameHits += 1;
        matched.add("name");
      }
    }
    if (nameHits) score += 50;
    if (queryText && docText.includes(queryText)) {
      score += 40;
      matched.add("summary");
    }
    if (queryText && nameText.includes(queryText)) score += 60;
    if (selected) score += 25;
    for (const term of terms) {
      if (queryTokens.has(term.term)) {
        score += Number(term.weight || 0);
        matched.add(term.facet);
      }
    }
    score += recencyScore(doc.build_last_used_at, 14);
    score += recencyScore(doc.updated_at, 15);
    if (String(doc.role || "") === "functional") score += 2;
    if (String(doc.role || "") === "embeddable") score += 1;
    return {
      asset_id: String(doc.asset_id || ""),
      conversation_id: String(doc.conversation_id || ""),
      name: String(doc.name || ""),
      kind: String(doc.kind || ""),
      category: String(doc.category || ""),
      folder_id: String(doc.folder_id || ""),
      usage: String(doc.usage || "auto"),
      role: String(doc.role || "unclassified"),
      score,
      matched_facets: Array.from(matched).sort(),
      selected,
      source: {
        summary_hash: String(doc.summary_hash || ""),
        updated_at: String(doc.updated_at || ""),
        build_last_used_at: String(doc.build_last_used_at || ""),
        indexed_at: String(doc.indexed_at || ""),
      },
    };
  }

  function buildTerms(asset, summary, role) {
    const terms = [];
    addTextTerms(terms, asset.name, "name", 6, true);
    addTextTerms(terms, asset.kind, "kind", 3, false);
    addTextTerms(terms, asset.category, "category", 3, false);
    addTextTerms(terms, asset.usage, "usage", 2, false);
    addTextTerms(terms, role, "role", 1, false);
    addTextTerms(terms, asset.folder_id, "folder", 1, false);
    for (const item of summaryFacets(summary)) {
      addTextTerms(terms, item.value, item.facet, item.weight, true);
    }
    return terms;
  }

  function addTextTerms(target, value, facet, weight, includePhrase) {
    const text = normalizeText(value);
    if (!text) return;
    if (includePhrase) target.push({ term: text, facet, weight });
    for (const token of tokenize(text)) {
      target.push({ term: token, facet, weight });
    }
  }

  function summaryFacets(summary) {
    const items = [];
    collectSummaryValues(summary, items, "summary", 4);
    return items;
  }

  function collectSummaryValues(value, out, facet, weight) {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = normalizeText(value);
      if (text) out.push({ value: text, facet, weight });
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collectSummaryValues(item, out, facet, weight);
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const next = facetFromKey(key, facet);
        const nextWeight = weightFromKey(key, weight);
        collectSummaryValues(item, out, next, nextWeight);
      }
    }
  }

  function facetFromKey(key, fallback) {
    const lower = String(key || "").toLowerCase();
    if (lower.includes("cta")) return "cta";
    if (lower.includes("field")) return "field";
    if (lower.includes("color") || lower.includes("palette")) return "color";
    if (lower.includes("signal")) return "signal";
    if (lower.includes("document")) return "document";
    if (lower.includes("design")) return "design";
    if (lower.includes("media")) return "media";
    if (lower === "use" || lower === "summary" || lower === "textpreview" || lower === "insights") return "summary";
    return fallback;
  }

  function weightFromKey(key, fallback) {
    const lower = String(key || "").toLowerCase();
    if (lower.includes("cta")) return Math.max(fallback, 5);
    if (lower.includes("field")) return Math.max(fallback, 4);
    if (lower.includes("color") || lower.includes("palette")) return Math.max(fallback, 2);
    if (lower.includes("signal")) return Math.max(fallback, 3);
    if (lower === "use" || lower === "summary" || lower === "textpreview") return Math.max(fallback, 4);
    return fallback;
  }

  function deriveRole(usage, buildLastUsedAt) {
    const value = String(usage || "auto");
    if (buildLastUsedAt) return "functional";
    if (value === "used_in_build") return "functional";
    if (value === "embeddable") return "embeddable";
    if (value === "reference_only") return "reference-only";
    if (value === "ignored") return "archived";
    return "unclassified";
  }

  function resolveAllowedRoles(filters) {
    if (Array.isArray(filters.allowedRoles) && filters.allowedRoles.length) {
      return new Set(filters.allowedRoles.map(String));
    }
    if (filters.includeReferenceOnly) {
      return new Set(["embeddable", "functional", "reference-only", "unclassified"]);
    }
    return new Set(["embeddable", "functional"]);
  }

  function matchesFilters(doc, filters) {
    const kinds = normalizeList(filters.kind || filters.kinds);
    if (kinds.length && !kinds.includes(String(doc.kind || ""))) return false;
    const categories = normalizeList(filters.category || filters.categories);
    if (categories.length && !categories.includes(String(doc.category || ""))) return false;
    const usages = normalizeList(filters.usage || filters.usages);
    if (usages.length && !usages.includes(String(doc.usage || ""))) return false;
    const folders = normalizeList(filters.folderId || filters.folder_id || filters.folderIds || filters.folder_ids);
    if (folders.length && !folders.includes(String(doc.folder_id || ""))) return false;
    return true;
  }

  function latestBuildUse(conversationId, assetId) {
    const rows = querySafe("SELECT MAX(created_at) AS build_last_used_at FROM build_asset_snapshots WHERE conversation_id = ? AND asset_id = ?", [conversationId, assetId]);
    return String(rows[0]?.build_last_used_at || "");
  }

  function getDoc(conversationId, assetId) {
    const rows = querySafe("SELECT * FROM asset_relevance_docs WHERE conversation_id = ? AND asset_id = ?", [conversationId, assetId]);
    return rows[0] || null;
  }

  function querySafe(sql, params = []) {
    try {
      const stmt = db.prepare(sql);
      if (params.length) stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    } catch {
      return [];
    }
  }

  function readAssetLibraryRows(scope = "") {
    const columns = new Set(querySafe("PRAGMA table_info(asset_library)").map(row => String(row.name || "")));
    if (!columns.size) return [];
    const select = [
      "id AS asset_id",
      "conversation_id",
      "name",
      "kind",
      columns.has("category") ? "category" : "'' AS category",
      columns.has("usage") ? "usage" : "'auto' AS usage",
      columns.has("folder_id") ? "folder_id" : "'' AS folder_id",
      columns.has("project_path") ? "project_path" : "'' AS project_path",
      columns.has("summary_json") ? "summary_json" : "'{}' AS summary_json",
      columns.has("updated_at") ? "updated_at" : (columns.has("created_at") ? "created_at AS updated_at" : "'' AS updated_at"),
      columns.has("created_at") ? "created_at" : "'' AS created_at",
    ].join(", ");
    const where = scope ? " WHERE conversation_id = ?" : "";
    return querySafe(`SELECT ${select} FROM asset_library${where}`, scope ? [scope] : []);
  }

  function runTransaction(task) {
    try {
      db.run("BEGIN TRANSACTION");
      const result = task();
      db.run("COMMIT");
      saveDb();
      return result;
    } catch (error) {
      try { db.run("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

function normalizeAssetInput(input = {}, options = {}) {
  const summary = parseSummaryJson(input.summary_json ?? input.summary ?? options.summary ?? {});
  const name = String(input.name || input.asset_name || "asset");
  const kind = String(input.kind || "binary");
  const category = String(input.category || categoryForKind(input.kind) || "");
  const usage = String(input.usage || options.usage || "auto");
  const conversation_id = cleanId(input.conversation_id || options.conversation_id || "");
  const asset_id = String(input.asset_id || input.id || "");
  const folder_id = String(input.folder_id || input.folderId || "");
  const project_path = String(input.project_path || input.projectPath || "");
  const updated_at = String(input.updated_at || input.updatedAt || input.created_at || input.createdAt || nowStamp());
  const created_at = String(input.created_at || input.createdAt || updated_at);
  return { asset_id, conversation_id, name, kind, category, usage, folder_id, project_path, summary, updated_at, created_at, build_last_used_at: String(options.build_last_used_at || input.build_last_used_at || "") };
}

function parseSummaryJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function buildNormalizedText(asset, summary, role, buildLastUsedAt) {
  const parts = [asset.name, asset.kind, asset.category, asset.usage, role, asset.folder_id, asset.project_path, buildLastUsedAt];
  parts.push(...summaryTextParts(summary));
  return normalizeText(parts.filter(Boolean).join(" "));
}

function summaryTextParts(summary) {
  const parts = [];
  collectSummaryText(summary, parts);
  return parts;
}

function collectSummaryText(value, parts) {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const text = String(value).trim();
    if (text) parts.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSummaryText(item, parts);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "summary_hash" || key === "created_at" || key === "updated_at") continue;
      collectSummaryText(item, parts);
    }
  }
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9#\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const text = normalizeText(value);
  if (!text) return [];
  const chunks = text.match(/[a-z0-9#]+|[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff]+/gi) || [];
  const tokens = [];
  for (const chunk of chunks) {
    if (/^[a-z0-9#]+$/i.test(chunk)) {
      tokens.push(chunk);
      continue;
    }
    const chars = Array.from(chunk);
    tokens.push(...chars);
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.push(chars[index] + chars[index + 1]);
    }
  }
  return tokens;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(item => String(item || "").trim()).filter(Boolean);
  const single = String(value || "").trim();
  return single ? [single] : [];
}

function clampLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) return 12;
  return Math.min(50, Math.floor(limit));
}

function groupTerms(rows) {
  const map = new Map();
  for (const row of rows) {
    const assetId = String(row.asset_id || "");
    if (!assetId) continue;
    if (!map.has(assetId)) map.set(assetId, []);
    map.get(assetId).push({ term: String(row.term || ""), facet: String(row.facet || ""), weight: Number(row.weight || 0) });
  }
  return map;
}

function compareResults(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const bBuild = Date.parse(b.source.build_last_used_at || "") || 0;
  const aBuild = Date.parse(a.source.build_last_used_at || "") || 0;
  if (bBuild !== aBuild) return bBuild - aBuild;
  const bUpdated = Date.parse(b.source.updated_at || "") || 0;
  const aUpdated = Date.parse(a.source.updated_at || "") || 0;
  if (bUpdated !== aUpdated) return bUpdated - aUpdated;
  const nameCompare = String(a.name || "").localeCompare(String(b.name || ""), "en");
  if (nameCompare !== 0) return nameCompare;
  return String(a.asset_id || "").localeCompare(String(b.asset_id || ""), "en");
}

function stripInternalFlags(result) {
  const { selected, ...rest } = result;
  return rest;
}

function cleanId(value) {
  return String(value || "").trim();
}

function recencyScore(value, scale) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time) || time <= 0) return 0;
  const ageDays = Math.max(0, (Date.now() - time) / 86400000);
  return Number(scale || 0) * Math.exp(-ageDays / 30);
}

function categoryForKind(kind = "") {
  if (kind === "image" || kind === "video" || kind === "audio") return kind;
  return "other";
}

function canonicalJson(value) {
  if (value == null) return "null";
  if (Array.isArray(value)) return "[" + value.map(item => canonicalJson(item)).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function nowStamp() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
