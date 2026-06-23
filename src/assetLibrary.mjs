import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";

export const ASSET_LIBRARY_LIMITS = Object.freeze({
  maxAssetCount: 80,
  maxAssetBytes: 12 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
  textPreviewBytes: 12 * 1024,
  maxArchiveEntries: 80,
  maxArchiveEntryBytes: 12 * 1024 * 1024,
  maxArchiveExpandedBytes: 48 * 1024 * 1024,
});

const TYPE_GROUPS = Object.freeze({
  image: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".avif"]),
  video: new Set([".mp4", ".webm", ".mov", ".m4v", ".avi"]),
  audio: new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]),
  component: new Set([".html", ".htm", ".css", ".js", ".mjs", ".jsx", ".tsx", ".vue", ".svelte"]),
  text: new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml"]),
  font: new Set([".ttf", ".otf", ".woff", ".woff2"]),
  data: new Set([".xml", ".geojson", ".ndjson"]),
  archive: new Set([".zip", ".tar", ".gz", ".rar", ".7z"]),
});

const TEXT_LIKE_EXTENSIONS = new Set([
  ...TYPE_GROUPS.component,
  ...TYPE_GROUPS.text,
  ...TYPE_GROUPS.data,
  ".svg",
]);

const BINARY_ENCODING = "base64";

export function createAssetLibraryStore(db, saveDb = () => {}) {
  return {
    initSchema() {
      db.run(`
        CREATE TABLE IF NOT EXISTS asset_library (
          id TEXT PRIMARY KEY,
          conversation_id TEXT,
          name TEXT NOT NULL,
          mime TEXT,
          kind TEXT NOT NULL,
          size INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          encoding TEXT NOT NULL,
          content TEXT,
          summary_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },

    listAssets(conversationId = "") {
      const rows = query(db, `
        SELECT id, conversation_id, name, mime, kind, size, sha256, summary_json, created_at
        FROM asset_library
        WHERE conversation_id = ? OR conversation_id = ''
        ORDER BY created_at DESC
      `, [conversationId]);
      return rows.map(row => publicAssetRow(row));
    },

    addAssets(conversationId = "", assets = []) {
      const normalized = normalizeIncomingAssets(assets, { existing: this.listAssets(conversationId) });
      runTransaction(db, saveDb, () => {
        for (const asset of normalized.assets) {
          asset.conversation_id = conversationId;
          runStep(db, `
            INSERT INTO asset_library (
              id, conversation_id, name, mime, kind, size, sha256, encoding, content, summary_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            asset.id,
            conversationId,
            asset.name,
            asset.mime,
            asset.kind,
            asset.size,
            asset.sha256,
            asset.encoding,
            asset.content,
            JSON.stringify(asset.summary),
          ]);
        }
      });
      return {
        assets: normalized.assets.map(publicAsset),
        rejected: normalized.rejected,
        summary: this.summarize(conversationId),
      };
    },

    deleteAsset(conversationId = "", assetId = "") {
      run(db, saveDb, "DELETE FROM asset_library WHERE id = ? AND (conversation_id = ? OR conversation_id = '')", [assetId, conversationId]);
    },

    deleteConversationAssets(conversationId = "") {
      run(db, saveDb, "DELETE FROM asset_library WHERE conversation_id = ?", [conversationId]);
    },

    promptContext(conversationId = "") {
      return formatAssetContext(this.listAssets(conversationId));
    },

    summarize(conversationId = "") {
      return summarizeAssets(this.listAssets(conversationId));
    },
  };
}

export function normalizeIncomingAssets(items = [], { existing = [] } = {}) {
  const assets = [];
  const rejected = [];
  let totalBytes = existing.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const existingCount = existing.length;

  for (const rawItem of Array.isArray(items) ? items : []) {
    try {
      if (existingCount + assets.length >= ASSET_LIBRARY_LIMITS.maxAssetCount) {
        throw new Error(`asset count limit is ${ASSET_LIBRARY_LIMITS.maxAssetCount}`);
      }
      const expanded = normalizeIncomingAssetBundle(rawItem);
      for (const asset of expanded.assets) {
        if (existingCount + assets.length >= ASSET_LIBRARY_LIMITS.maxAssetCount) {
          throw new Error(`asset count limit is ${ASSET_LIBRARY_LIMITS.maxAssetCount}`);
        }
        if (asset.size > ASSET_LIBRARY_LIMITS.maxAssetBytes) {
          throw new Error(`${asset.name} is larger than ${ASSET_LIBRARY_LIMITS.maxAssetBytes} bytes`);
        }
        if (totalBytes + asset.size > ASSET_LIBRARY_LIMITS.maxTotalBytes) {
          throw new Error(`asset library total size limit is ${ASSET_LIBRARY_LIMITS.maxTotalBytes} bytes`);
        }
        totalBytes += asset.size;
        assets.push(asset);
      }
      rejected.push(...expanded.rejected);
    } catch (error) {
      rejected.push({
        name: String(rawItem?.name || "unnamed"),
        error: error.message,
      });
    }
  }

  return { assets, rejected };
}

export function normalizeIncomingAssetBundle(item = {}) {
  const root = normalizeIncomingAsset(item);
  if (root.kind !== "archive" || path.posix.extname(root.name).toLowerCase() !== ".zip") {
    return { assets: [root], rejected: [] };
  }

  const buffer = Buffer.from(root.content, BINARY_ENCODING);
  const unpacked = unpackZipAssets(buffer, root.name);
  root.summary = {
    ...root.summary,
    extractedCount: unpacked.assets.length,
    rejectedCount: unpacked.rejected.length,
    signals: [
      ...root.summary.signals.filter(signal => !signal.includes("Deep unpacking is not enabled")),
      `ZIP archive extracted ${unpacked.assets.length} supported files for analysis.`,
      ...unpacked.rejected.slice(0, 3).map(item => `ZIP skipped ${item.name}: ${item.error}`),
    ],
  };
  return {
    assets: [root, ...unpacked.assets],
    rejected: unpacked.rejected,
  };
}

export function normalizeIncomingAsset(item = {}) {
  const name = item.preservePath
    ? sanitizeAssetPathName(item.name || item.filename || "asset")
    : sanitizeAssetName(item.name || item.filename || "asset");
  const mime = String(item.mime || item.type || "").trim().slice(0, 120);
  const rawContent = String(item.content || item.data || "");
  const encoding = String(item.encoding || "").trim().toLowerCase() || inferEncoding(rawContent);
  const buffer = decodeAssetContent(rawContent, encoding);
  const size = buffer.byteLength;
  const ext = path.posix.extname(name).toLowerCase();
  const kind = classifyAsset({ name, mime, ext });
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const textPreview = shouldPreviewText(ext, mime, buffer)
    ? buffer.toString("utf8", 0, Math.min(buffer.byteLength, ASSET_LIBRARY_LIMITS.textPreviewBytes))
    : "";
  const summary = analyzeAsset({ name, mime, kind, ext, size, sha256, textPreview });

  return {
    id: `asset-${sha256.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`,
    name,
    mime,
    kind,
    size,
    sha256,
    encoding: BINARY_ENCODING,
    content: buffer.toString(BINARY_ENCODING),
    summary,
  };
}

export function classifyAsset({ name = "", mime = "", ext = path.posix.extname(name).toLowerCase() } = {}) {
  const lowerMime = String(mime || "").toLowerCase();
  if (lowerMime.startsWith("image/")) return "image";
  if (lowerMime.startsWith("video/")) return "video";
  if (lowerMime.startsWith("audio/")) return "audio";
  if (lowerMime.includes("font")) return "font";
  for (const [kind, extensions] of Object.entries(TYPE_GROUPS)) {
    if (extensions.has(ext)) return kind;
  }
  if (lowerMime.startsWith("text/")) return "text";
  return "binary";
}

export function analyzeAsset({ name, mime, kind, ext, size, sha256, textPreview = "" }) {
  const summary = {
    name,
    mime,
    kind,
    extension: ext,
    size,
    sha256,
    use: suggestedUse(kind, ext),
    signals: [],
    textPreview: "",
  };

  if (textPreview) {
    const compact = compactText(textPreview);
    summary.textPreview = compact.slice(0, 1200);
    summary.signals = extractTextSignals(compact);
  }

  if (kind === "archive") {
    summary.signals.push("Archive uploaded. Supported ZIP files are unpacked into separate analyzed assets.");
  }
  if (kind === "component" && [".html", ".htm"].includes(ext)) {
    summary.signals.push("HTML component can inform layout, but generated hardware app must still be self-contained and contract-safe.");
  }
  if (kind === "video") summary.signals.push("Video can be used as visual reference or compressed media for the 480x360 screen.");
  if (kind === "audio") summary.signals.push("Audio can support startup sounds, alerts, voice UI, or ambience when hardware audio is available.");
  return summary;
}

export function unpackZipAssets(buffer, archiveName = "assets.zip") {
  const assets = [];
  const rejected = [];
  let offset = 0;
  let expandedBytes = 0;
  const prefix = archivePrefix(archiveName);

  while (offset + 30 <= buffer.length && assets.length + rejected.length < ASSET_LIBRARY_LIMITS.maxArchiveEntries) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const uncompressedSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (flags & 0x08) {
      rejected.push({ name: archiveName, error: "ZIP data descriptors are not supported yet" });
      break;
    }
    if (dataEnd > buffer.length) {
      rejected.push({ name: archiveName, error: "ZIP entry extends beyond archive size" });
      break;
    }
    const entryName = buffer.toString("utf8", nameStart, nameStart + nameLength);
    offset = dataEnd;
    if (!entryName || entryName.endsWith("/")) continue;

    try {
      const safeName = safeArchiveEntryName(entryName, prefix);
      if (uncompressedSize > ASSET_LIBRARY_LIMITS.maxArchiveEntryBytes) {
        throw new Error(`entry exceeds ${ASSET_LIBRARY_LIMITS.maxArchiveEntryBytes} bytes`);
      }
      if (expandedBytes + uncompressedSize > ASSET_LIBRARY_LIMITS.maxArchiveExpandedBytes) {
        throw new Error(`expanded ZIP exceeds ${ASSET_LIBRARY_LIMITS.maxArchiveExpandedBytes} bytes`);
      }
      const compressed = buffer.subarray(dataStart, dataEnd);
      const content = inflateZipEntry(compressed, method);
      expandedBytes += content.byteLength;
      assets.push(normalizeIncomingAsset({
        name: safeName,
        mime: mimeFromName(safeName),
        encoding: BINARY_ENCODING,
        content: content.toString(BINARY_ENCODING),
        preservePath: true,
      }));
    } catch (error) {
      rejected.push({ name: entryName, error: error.message });
    }
  }

  if (assets.length + rejected.length >= ASSET_LIBRARY_LIMITS.maxArchiveEntries) {
    rejected.push({ name: archiveName, error: `ZIP entry limit is ${ASSET_LIBRARY_LIMITS.maxArchiveEntries}` });
  }
  return { assets, rejected };
}

export function summarizeAssets(assets = []) {
  const list = Array.isArray(assets) ? assets.map(asset => asset.summary ? asset : publicAssetRow(asset)) : [];
  const byKind = {};
  let totalBytes = 0;
  for (const asset of list) {
    byKind[asset.kind] = (byKind[asset.kind] || 0) + 1;
    totalBytes += Number(asset.size || 0);
  }
  return {
    count: list.length,
    totalBytes,
    byKind,
    items: list.slice(0, 24).map(asset => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      size: asset.size,
      use: asset.summary?.use || suggestedUse(asset.kind, path.posix.extname(asset.name).toLowerCase()),
      signals: (asset.summary?.signals || []).slice(0, 4),
      textPreview: asset.summary?.textPreview || "",
    })),
  };
}

export function formatAssetContext(assets = []) {
  const summary = summarizeAssets(assets);
  if (!summary.count) return "";
  const lines = [
    "## Uploaded asset library",
    `Total assets: ${summary.count}; total bytes: ${summary.totalBytes}`,
    `Kinds: ${Object.entries(summary.byKind).map(([kind, count]) => `${kind}=${count}`).join(", ") || "none"}`,
    "Use these assets only for 480x360 hardware embedded UI design. Do not perform unrelated file operations.",
  ];
  for (const item of summary.items) {
    lines.push(`- ${item.name} (${item.kind}, ${item.size} bytes): ${item.use}`);
    for (const signal of item.signals.slice(0, 2)) lines.push(`  signal: ${signal}`);
    if (item.textPreview) lines.push(`  preview: ${item.textPreview.slice(0, 240)}`);
  }
  return `\n\n${lines.join("\n")}`;
}

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function run(db, saveDb, sql, params = []) {
  db.run(sql, params);
  saveDb();
}

function runStep(db, sql, params = []) {
  db.run(sql, params);
}

function runTransaction(db, saveDb, task) {
  db.run("BEGIN TRANSACTION");
  try {
    const result = task();
    db.run("COMMIT");
    saveDb();
    return result;
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {}
    throw error;
  }
}

function publicAssetRow(row = {}) {
  let summary = {};
  try {
    summary = typeof row.summary_json === "string" ? JSON.parse(row.summary_json) : row.summary || {};
  } catch {}
  return publicAsset({ ...row, summary });
}

function publicAsset(asset = {}) {
  return {
    id: asset.id,
    conversation_id: asset.conversation_id || "",
    name: asset.name,
    mime: asset.mime || "",
    kind: asset.kind,
    size: Number(asset.size || 0),
    sha256: asset.sha256,
    summary: asset.summary || {},
    created_at: asset.created_at || "",
  };
}

function sanitizeAssetName(value) {
  const raw = String(value || "asset").replaceAll("\\", "/").split("/").pop().trim();
  const safe = sanitizeAssetSegment(raw).slice(0, 120);
  return safe || "asset";
}

function sanitizeAssetPathName(value) {
  const normalized = path.posix.normalize(String(value || "asset").replaceAll("\\", "/"));
  const parts = normalized.split("/").map(part => sanitizeAssetSegment(part)).filter(Boolean);
  return parts.join("/") || "asset";
}

function archivePrefix(value) {
  const base = sanitizeAssetName(String(value || "archive").replace(/\.zip$/i, ""));
  return base || "archive";
}

function safeArchiveEntryName(entryName, prefix) {
  const normalized = path.posix.normalize(String(entryName || "").replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error("unsafe ZIP entry path");
  }
  const parts = normalized.split("/").map(part => sanitizeAssetSegment(part)).filter(Boolean);
  if (!parts.length) throw new Error("empty ZIP entry path");
  return `${prefix}/${parts.join("/")}`;
}

function sanitizeAssetSegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^\w\u4e00-\u9fff .@()+\-[\]]+/g, "_")
    .replace(/\s+/g, " ");
}

function inflateZipEntry(compressed, method) {
  if (method === 0) return Buffer.from(compressed);
  if (method === 8) return zlib.inflateRawSync(compressed, {
    maxOutputLength: ASSET_LIBRARY_LIMITS.maxArchiveEntryBytes,
  });
  throw new Error(`unsupported ZIP compression method ${method}`);
}

function mimeFromName(name) {
  const ext = path.posix.extname(name).toLowerCase();
  if ([".png"].includes(ext)) return "image/png";
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if ([".webp"].includes(ext)) return "image/webp";
  if ([".gif"].includes(ext)) return "image/gif";
  if ([".svg"].includes(ext)) return "image/svg+xml";
  if ([".mp4"].includes(ext)) return "video/mp4";
  if ([".webm"].includes(ext)) return "video/webm";
  if ([".mp3"].includes(ext)) return "audio/mpeg";
  if ([".wav"].includes(ext)) return "audio/wav";
  if ([".html", ".htm"].includes(ext)) return "text/html";
  if ([".css"].includes(ext)) return "text/css";
  if ([".js", ".mjs"].includes(ext)) return "text/javascript";
  if ([".json"].includes(ext)) return "application/json";
  if (TEXT_LIKE_EXTENSIONS.has(ext)) return "text/plain";
  return "application/octet-stream";
}

function inferEncoding(content) {
  if (/^data:[^;]+;base64,/.test(content)) return "data-url";
  return "base64";
}

function decodeAssetContent(content, encoding) {
  if (encoding === "text" || encoding === "utf8" || encoding === "utf-8") {
    return Buffer.from(content, "utf8");
  }
  if (encoding === "data-url") {
    const comma = content.indexOf(",");
    if (comma < 0) throw new Error("invalid data URL");
    return Buffer.from(content.slice(comma + 1), "base64");
  }
  return Buffer.from(content.replace(/^data:[^,]+,/, ""), "base64");
}

function shouldPreviewText(ext, mime, buffer) {
  if (!TEXT_LIKE_EXTENSIONS.has(ext) && !String(mime || "").startsWith("text/")) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  return !sample.includes(0);
}

function suggestedUse(kind, ext) {
  if (kind === "image") return "visual material, product/photo background, icon, texture, or slideshow source";
  if (kind === "video") return "motion reference or short media element when compressed for embedded playback";
  if (kind === "audio") return "sound cue, notification, ambience, or voice interaction asset";
  if (kind === "component") return "layout/component reference to adapt into the generated hardware UI";
  if (kind === "text") return "copy, data, labels, structured content, or design brief";
  if (kind === "font") return "typographic direction if compatible with generated app constraints";
  if (kind === "archive") return "asset bundle; supported ZIP entries are unpacked and analyzed as separate assets";
  if (kind === "data") return "structured data source for labels, dashboards, or state displays";
  return `supporting binary asset${ext ? ` (${ext})` : ""}`;
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractTextSignals(text) {
  const signals = [];
  const lower = text.toLowerCase();
  if (/<(section|article|main|canvas|video|audio|img|button)\b/i.test(text)) signals.push("Contains UI/component markup.");
  if (/(品牌|brand|logo|palette|色彩|font|typography|视觉|style)/i.test(text)) signals.push("Mentions visual identity or styling.");
  if (/(api|json|csv|data|status|sensor|metric|dashboard|监控|数据|指标)/i.test(text)) signals.push("Mentions data, metrics, or dashboard content.");
  if (/(music|audio|sound|voice|语音|音乐|音效|录音)/i.test(text)) signals.push("Mentions audio or voice behavior.");
  if (/(video|motion|animation|动画|视频|动效)/i.test(text)) signals.push("Mentions motion or video behavior.");
  if (lower.includes("480") || lower.includes("360")) signals.push("Mentions target screen dimensions.");
  return signals.slice(0, 6);
}
