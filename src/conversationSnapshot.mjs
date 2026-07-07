import {
  declaredAssetPathsFromFiles,
  deserializeFileMap,
  serializeFileMap,
} from "./assetContract.mjs";
import { CONVERSATION_SNAPSHOT_FILE_NAMES } from "./contracts.mjs";
import { createStructuredError } from "./errorClassifier.mjs";

export const CONVERSATION_FILE_NAMES = new Set(CONVERSATION_SNAPSHOT_FILE_NAMES);
export const REQUIRED_EDIT_FILE_NAMES = Object.freeze(["index.html", "style.css", "app.js"]);

export function filterConversationFiles(files = {}) {
  const decoded = deserializeFileMap(files);
  const declaredAssets = new Set(declaredAssetPathsFromFiles(decoded));
  const filtered = {};
  for (const [filename, content] of Object.entries(decoded || {})) {
    if (!CONVERSATION_FILE_NAMES.has(filename) && !declaredAssets.has(filename)) continue;
    filtered[filename] = content;
  }
  return filtered;
}

export function serializeConversationFiles(files = {}) {
  return serializeFileMap(filterConversationFiles(files));
}

export function normalizeConversationFileRows(rows = []) {
  const orderedRows = Array.isArray(rows) ? rows : [];
  if (!orderedRows.length) return { buildId: null, files: {} };
  const files = {};
  for (const row of orderedRows) {
    const filename = String(row?.filename || "");
    if (!filename) continue;
    if (CONVERSATION_FILE_NAMES.has(filename)) {
      files[filename] = row.content;
      continue;
    }
    const content = parseStoredFileContent(row.content);
    const candidate = { ...files, [filename]: content };
    if (declaredAssetPathsFromFiles(candidate).includes(filename)) {
      files[filename] = content;
    }
  }
  return {
    buildId: selectConversationBuildId(orderedRows),
    files: deserializeFileMap(files),
  };
}

export function selectConversationBuildId(rowsOrSnapshot = []) {
  if (Array.isArray(rowsOrSnapshot)) {
    const row = rowsOrSnapshot.find(item => String(item?.build_id || item?.buildId || "").trim());
    return row ? String(row.build_id || row.buildId || "").trim() : null;
  }
  return String(rowsOrSnapshot?.buildId || rowsOrSnapshot?.build_id || "").trim() || null;
}

export function hasEditableConversationFiles(files = {}) {
  const safeFiles = filterConversationFiles(files);
  return Object.keys(safeFiles).some(name => name !== "manifest.json");
}

export function assertEditBuildBinding({ body = {}, conversationId = "", snapshot = {}, fileStore = null } = {}) {
  const files = fileStore || snapshot?.files || {};
  if (!hasEditableConversationFiles(files)) return;
  const currentBuildId = normalizeBuildId(body.current_build_id || body.currentBuildId);
  const expectedBuildId = normalizeBuildId(snapshot?.buildId || snapshot?.build_id);
  if (!currentBuildId) {
    throw createStructuredError(
      "This edit must include current_build_id so it can be applied to the existing build instead of starting a new project.",
      "build_context_required",
      {
        statusCode: 409,
        conversationId,
        expectedBuildId,
        errorStage: "edit_context",
        retryable: false,
      },
    );
  }
  if (!expectedBuildId) {
    throw createStructuredError(
      "The current conversation has files but no saved build id. Please reopen the latest build before editing.",
      "build_context_missing",
      {
        statusCode: 409,
        conversationId,
        currentBuildId,
        errorStage: "edit_context",
        retryable: false,
      },
    );
  }
  if (currentBuildId !== expectedBuildId) {
    throw createStructuredError(
      "This edit is based on an older build. Reload the latest preview before continuing.",
      "build_context_stale",
      {
        statusCode: 409,
        conversationId,
        currentBuildId,
        expectedBuildId,
        errorStage: "edit_context",
        retryable: false,
      },
    );
  }
  const missing = REQUIRED_EDIT_FILE_NAMES.filter(name => !files[name]);
  if (missing.length) {
    throw createStructuredError(
      `The current build is missing required files for editing: ${missing.join(", ")}.`,
      "build_context_incomplete",
      {
        statusCode: 409,
        conversationId,
        currentBuildId,
        missingFiles: missing,
        errorStage: "edit_context",
        retryable: false,
      },
    );
  }
}

function normalizeBuildId(value) {
  return String(value || "").trim();
}

function parseStoredFileContent(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.__vibeboardFileEncoding === "base64" || parsed.type === "Buffer")
    ) {
      return parsed;
    }
  } catch {}
  return value;
}
