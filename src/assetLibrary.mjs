import crypto from "node:crypto";
import path from "node:path";

export const ASSET_LIBRARY_LIMITS = Object.freeze({
  maxAssetCount: 80,
  maxAssetBytes: 12 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
  textPreviewBytes: 12 * 1024,
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
      const asset = normalizeIncomingAsset(rawItem);
      if (asset.size > ASSET_LIBRARY_LIMITS.maxAssetBytes) {
        throw new Error(`${asset.name} is larger than ${ASSET_LIBRARY_LIMITS.maxAssetBytes} bytes`);
      }
      if (totalBytes + asset.size > ASSET_LIBRARY_LIMITS.maxTotalBytes) {
        throw new Error(`asset library total size limit is ${ASSET_LIBRARY_LIMITS.maxTotalBytes} bytes`);
      }
      totalBytes += asset.size;
      assets.push(asset);
    } catch (error) {
      rejected.push({
        name: String(rawItem?.name || "unnamed"),
        error: error.message,
      });
    }
  }

  return { assets, rejected };
}

export function normalizeIncomingAsset(item = {}) {
  const name = sanitizeAssetName(item.name || item.filename || "asset");
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
    summary.signals.push("Archive uploaded. Deep unpacking is not enabled yet; upload extracted files for full analysis.");
  }
  if (kind === "component" && [".html", ".htm"].includes(ext)) {
    summary.signals.push("HTML component can inform layout, but generated hardware app must still be self-contained and contract-safe.");
  }
  if (kind === "video") summary.signals.push("Video can be used as visual reference or compressed media for the 480x360 screen.");
  if (kind === "audio") summary.signals.push("Audio can support startup sounds, alerts, voice UI, or ambience when hardware audio is available.");
  return summary;
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
  const safe = raw.replace(/[^\w\u4e00-\u9fff .@()+\-[\]]+/g, "_").replace(/\s+/g, " ").slice(0, 120);
  return safe || "asset";
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
  if (kind === "archive") return "asset bundle placeholder; upload extracted files for deeper analysis";
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
