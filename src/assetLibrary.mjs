import crypto from "node:crypto";
import path from "node:path";
import zlib from "node:zlib";
import {
  ALLOWED_ASSET_EXTENSIONS,
  MAX_ASSET_BYTES,
  MAX_TOTAL_ASSET_BYTES,
  normalizeAssetPath,
} from "./assetContract.mjs";

export const ASSET_LIBRARY_LIMITS = Object.freeze({
  maxAssetCount: 80,
  maxAssetBytes: 12 * 1024 * 1024,
  maxTotalBytes: 48 * 1024 * 1024,
  textPreviewBytes: 12 * 1024,
  maxArchiveEntries: 80,
  maxArchiveEntryBytes: 12 * 1024 * 1024,
  maxArchiveExpandedBytes: 48 * 1024 * 1024,
});

export const GENERATED_ASSET_LIMITS = Object.freeze({
  root: "assets/uploaded",
  maxAssetCount: 24,
  maxAssetBytes: MAX_ASSET_BYTES,
  maxTotalBytes: MAX_TOTAL_ASSET_BYTES,
});

const TYPE_GROUPS = Object.freeze({
  image: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".avif"]),
  video: new Set([".mp4", ".webm", ".mov", ".m4v", ".avi"]),
  audio: new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]),
  component: new Set([".html", ".htm", ".css", ".js", ".mjs", ".jsx", ".tsx", ".vue", ".svelte"]),
  text: new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".yaml", ".yml"]),
  font: new Set([".ttf", ".otf", ".woff", ".woff2"]),
  data: new Set([".xml", ".geojson", ".ndjson"]),
  document: new Set([".pdf", ".docx", ".pptx", ".xlsx", ".doc", ".ppt", ".xls", ".rtf"]),
  design: new Set([".fig", ".sketch", ".psd", ".ai", ".xd", ".afdesign", ".ase", ".aco", ".tokens", ".design"]),
  archive: new Set([".zip", ".tar", ".tgz", ".gz", ".rar", ".7z"]),
});

const TEXT_LIKE_EXTENSIONS = new Set([
  ...TYPE_GROUPS.component,
  ...TYPE_GROUPS.text,
  ...TYPE_GROUPS.data,
  ".svg",
]);

const GENERATED_ASSET_KINDS = new Set(["image", "video", "audio", "font", "text", "data"]);
const BINARY_ENCODING = "base64";
const DEFAULT_ASSET_FOLDERS = Object.freeze([
  { id: "folder-images", name: "图片", category: "image", system: true },
  { id: "folder-videos", name: "视频", category: "video", system: true },
  { id: "folder-audio", name: "音频", category: "audio", system: true },
  { id: "folder-other", name: "其他", category: "other", system: true },
]);

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
          usage TEXT DEFAULT 'auto',
          folder_id TEXT,
          project_path TEXT,
          encoding TEXT NOT NULL,
          content TEXT,
          summary_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      ensureColumn(db, "asset_library", "usage", "TEXT DEFAULT 'auto'");
      ensureColumn(db, "asset_library", "folder_id", "TEXT");
      ensureColumn(db, "asset_library", "project_path", "TEXT");
      db.run(`
        CREATE TABLE IF NOT EXISTS asset_folders (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          name TEXT NOT NULL,
          category TEXT DEFAULT 'custom',
          system INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.run(`
        CREATE TABLE IF NOT EXISTS build_asset_snapshots (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          build_id TEXT NOT NULL,
          asset_id TEXT NOT NULL,
          usage TEXT NOT NULL,
          project_path TEXT,
          generated_path TEXT,
          sha256 TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },

    listAssets(conversationId = "") {
      const id = String(conversationId || "").trim();
      this.ensureDefaultFolders(conversationId);
      const rows = query(db, `
        SELECT id, conversation_id, name, mime, kind, size, sha256, usage, folder_id, project_path, summary_json, created_at
        FROM asset_library
        WHERE conversation_id = ? OR conversation_id = ''
        ORDER BY created_at DESC
      `, [conversationId]);
      return rows.map(row => publicAssetRow(row, id));
    },

    ensureDefaultFolders(conversationId = "") {
      const id = String(conversationId || "").trim();
      if (!id) return [];
      runTransaction(db, saveDb, () => {
        for (const folder of DEFAULT_ASSET_FOLDERS) {
          runStep(db, `
            INSERT INTO asset_folders (id, conversation_id, name, category, system, updated_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(id) DO NOTHING
          `, [scopedFolderId(id, folder.id), id, folder.name, folder.category, folder.system ? 1 : 0]);
        }
        const unfiledAssets = query(db, `
          SELECT id, kind
          FROM asset_library
          WHERE conversation_id = ? AND (folder_id IS NULL OR folder_id = '')
        `, [id]);
        for (const asset of unfiledAssets) {
          runStep(db, "UPDATE asset_library SET folder_id = ? WHERE id = ? AND conversation_id = ?", [
            defaultFolderIdForKind(id, asset.kind),
            asset.id,
            id,
          ]);
        }
      });
      return this.listFolders(id);
    },

    listFolders(conversationId = "") {
      const id = String(conversationId || "").trim();
      if (!id) return [];
      const rows = query(db, `
        SELECT f.id, f.conversation_id, f.name, f.category, f.system, f.created_at, f.updated_at,
               COUNT(a.id) AS asset_count,
               COALESCE(SUM(a.size), 0) AS total_bytes
        FROM asset_folders f
        LEFT JOIN asset_library a ON a.folder_id = f.id AND a.conversation_id = f.conversation_id
        WHERE f.conversation_id = ?
        GROUP BY f.id
        ORDER BY f.system DESC,
          CASE f.category WHEN 'image' THEN 1 WHEN 'video' THEN 2 WHEN 'audio' THEN 3 WHEN 'other' THEN 4 ELSE 5 END,
          f.name COLLATE NOCASE ASC
      `, [id]);
      return rows.map(publicFolderRow);
    },

    createFolder(conversationId = "", name = "新建文件夹") {
      this.ensureDefaultFolders(conversationId);
      const folder = {
        id: `folder-${crypto.randomUUID()}`,
        conversation_id: conversationId,
        name: sanitizeFolderName(name),
        category: "custom",
        system: 0,
      };
      run(db, saveDb, `
        INSERT INTO asset_folders (id, conversation_id, name, category, system)
        VALUES (?, ?, ?, ?, ?)
      `, [folder.id, conversationId, folder.name, folder.category, folder.system]);
      return this.getFolder(conversationId, folder.id);
    },

    getFolder(conversationId = "", folderId = "") {
      const rows = query(db, `
        SELECT id, conversation_id, name, category, system, created_at, updated_at
        FROM asset_folders
        WHERE id = ? AND conversation_id = ?
      `, [folderId, conversationId]);
      return rows[0] ? publicFolderRow(rows[0]) : null;
    },

    updateFolder(conversationId = "", folderId = "", patch = {}) {
      const current = this.getFolder(conversationId, folderId);
      if (!current) return null;
      if (current.system) {
        throw Object.assign(new Error("System folders cannot be renamed."), { statusCode: 400, errorType: "system_folder_locked" });
      }
      const name = sanitizeFolderName(patch.name || current.name);
      run(db, saveDb, "UPDATE asset_folders SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND conversation_id = ?", [name, folderId, conversationId]);
      return this.getFolder(conversationId, folderId);
    },

    deleteFolder(conversationId = "", folderId = "") {
      const current = this.getFolder(conversationId, folderId);
      if (!current) return null;
      if (current.system) {
        throw Object.assign(new Error("System folders cannot be deleted."), { statusCode: 400, errorType: "system_folder_locked" });
      }
      const fallback = defaultFolderIdForKind(conversationId, "other");
      runTransaction(db, saveDb, () => {
        runStep(db, "UPDATE asset_library SET folder_id = ? WHERE conversation_id = ? AND folder_id = ?", [fallback, conversationId, folderId]);
        runStep(db, "DELETE FROM asset_folders WHERE id = ? AND conversation_id = ?", [folderId, conversationId]);
      });
      return { id: folderId, moved_to: fallback };
    },

    addAssets(conversationId = "", assets = [], options = {}) {
      const normalized = normalizeIncomingAssets(assets, { existing: this.listAssets(conversationId) });
      const persistAssetFile = typeof options.persistAssetFile === "function" ? options.persistAssetFile : null;
      this.ensureDefaultFolders(conversationId);
      runTransaction(db, saveDb, () => {
        for (const asset of normalized.assets) {
          asset.conversation_id = conversationId;
          asset.usage = normalizeUsage(asset.usage || options.usage || inferredUsage(asset));
          asset.folder_id = options.folderId || options.folder_id || defaultFolderIdForKind(conversationId, asset.kind);
          asset.project_path = "";
          runStep(db, `
            INSERT INTO asset_library (
              id, conversation_id, name, mime, kind, size, sha256, usage, folder_id, project_path, encoding, content, summary_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            asset.id,
            conversationId,
            asset.name,
            asset.mime,
            asset.kind,
            asset.size,
            asset.sha256,
            asset.usage,
            asset.folder_id,
            asset.project_path,
            asset.encoding,
            asset.content,
            JSON.stringify(asset.summary),
          ]);
        }
      });
      const persistence = [];
      if (persistAssetFile) {
        for (const asset of normalized.assets) {
          persistence.push(Promise.resolve(persistAssetFile(asset))
            .then(projectPath => {
              if (projectPath) this.updateAsset(conversationId, asset.id, { projectPath });
            })
            .catch(() => {}));
        }
      }
      const result = {
        assets: normalized.assets.map(publicAsset),
        rejected: normalized.rejected,
        summary: this.summarize(conversationId),
      };
      Object.defineProperty(result, "persistence", {
        value: Promise.all(persistence),
        enumerable: false,
      });
      return result;
    },

    updateAsset(conversationId = "", assetId = "", patch = {}) {
      const updates = [];
      const params = [];
      if (patch.name != null) {
        updates.push("name = ?");
        params.push(sanitizeAssetName(patch.name));
      }
      if (patch.usage != null) {
        updates.push("usage = ?");
        params.push(normalizeUsage(patch.usage));
      }
      if (patch.folderId != null || patch.folder_id != null) {
        updates.push("folder_id = ?");
        params.push(String(patch.folderId ?? patch.folder_id ?? ""));
      }
      if (patch.projectPath != null || patch.project_path != null) {
        updates.push("project_path = ?");
        params.push(String(patch.projectPath ?? patch.project_path ?? ""));
      }
      if (!updates.length) return this.getAsset(conversationId, assetId);
      params.push(assetId, conversationId);
      run(db, saveDb, `UPDATE asset_library SET ${updates.join(", ")} WHERE id = ? AND (conversation_id = ? OR conversation_id = '')`, params);
      return this.getAsset(conversationId, assetId);
    },

    getAsset(conversationId = "", assetId = "") {
      const rows = query(db, `
        SELECT id, conversation_id, name, mime, kind, size, sha256, usage, folder_id, project_path, summary_json, created_at
        FROM asset_library
        WHERE id = ? AND (conversation_id = ? OR conversation_id = '')
      `, [assetId, conversationId]);
      return rows[0] ? publicAssetRow(rows[0], conversationId) : null;
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

    generatedAssets(conversationId = "") {
      const rows = query(db, `
        SELECT id, conversation_id, name, mime, kind, size, sha256, usage, folder_id, project_path, encoding, content, summary_json, created_at
        FROM asset_library
        WHERE conversation_id = ? OR conversation_id = ''
        ORDER BY created_at ASC
      `, [conversationId]);
      return selectGeneratedAssets(rows.map(storedAssetRow));
    },

    recordBuildSnapshot(conversationId = "", buildId = "", embeddedAssets = {}) {
      const items = Array.isArray(embeddedAssets.items) ? embeddedAssets.items : [];
      runTransaction(db, saveDb, () => {
        runStep(db, "DELETE FROM build_asset_snapshots WHERE conversation_id = ? AND build_id = ?", [conversationId, buildId]);
        for (const item of items) {
          runStep(db, `
            INSERT INTO build_asset_snapshots (
              id, conversation_id, build_id, asset_id, usage, project_path, generated_path, sha256
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            `snap-${buildId}-${item.id || item.path || crypto.randomUUID()}`.slice(0, 180),
            conversationId,
            buildId,
            item.id || "",
            "used_in_build",
            item.project_path || "",
            item.path || "",
            item.sha256 || "",
          ]);
          if (item.id) {
            runStep(db, "UPDATE asset_library SET usage = ? WHERE id = ? AND conversation_id = ?", ["used_in_build", item.id, conversationId]);
          }
        }
      });
      return this.listBuildSnapshots(conversationId, buildId);
    },

    listBuildSnapshots(conversationId = "", buildId = "") {
      const params = [conversationId];
      let where = "conversation_id = ?";
      if (buildId) {
        where += " AND build_id = ?";
        params.push(buildId);
      }
      return query(db, `
        SELECT * FROM build_asset_snapshots
        WHERE ${where}
        ORDER BY created_at DESC
      `, params);
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
  const archiveFormat = archiveFormatFromName(root.name);
  if (root.kind !== "archive" || !archiveFormat) {
    return { assets: [root], rejected: [] };
  }

  const buffer = Buffer.from(root.content, BINARY_ENCODING);
  const unpacked = unpackArchiveAssets(buffer, root.name, archiveFormat);
  const archiveLabel = archiveFormat.toUpperCase();
  root.summary = {
    ...root.summary,
    extractedCount: unpacked.assets.length,
    rejectedCount: unpacked.rejected.length,
    signals: [
      ...root.summary.signals.filter(signal => !signal.includes("Deep unpacking is not enabled")),
      `${archiveLabel} archive extracted ${unpacked.assets.length} supported files for analysis.`,
      ...unpacked.rejected.slice(0, 3).map(item => `${archiveLabel} skipped ${item.name}: ${item.error}`),
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
  const documentProfile = analyzeDocumentProfile({ name, mime, kind, ext, size, buffer });
  const designProfile = analyzeDesignProfile({ name, mime, kind, ext, size, buffer, text: textPreview || "" });
  const summary = analyzeAsset({ name, mime, kind, ext, size, sha256, textPreview: textPreview || documentProfile.textPreview || designProfile.textPreview || "", buffer, documentProfile, designProfile });

  return {
    id: `asset-${sha256.slice(0, 12)}-${crypto.randomUUID().slice(0, 8)}`,
    name,
    mime,
    kind,
    size,
    sha256,
    usage: item.usage == null ? undefined : normalizeUsage(item.usage),
    encoding: BINARY_ENCODING,
    content: buffer.toString(BINARY_ENCODING),
    summary,
  };
}

export function selectGeneratedAssets(assets = []) {
  const files = {};
  const items = [];
  const rejected = [];
  const usedPaths = new Set();
  let totalBytes = 0;

  for (const asset of Array.isArray(assets) ? assets : []) {
    try {
      if (items.length >= GENERATED_ASSET_LIMITS.maxAssetCount) {
        throw new Error(`generated asset count limit is ${GENERATED_ASSET_LIMITS.maxAssetCount}`);
      }
      const targetPath = generatedAssetPath(asset, usedPaths);
      const content = decodeStoredAssetContent(asset);
      const size = content.byteLength;
      if (size > GENERATED_ASSET_LIMITS.maxAssetBytes) {
        throw new Error(`${asset.name || "asset"} is larger than ${GENERATED_ASSET_LIMITS.maxAssetBytes} bytes`);
      }
      if (totalBytes + size > GENERATED_ASSET_LIMITS.maxTotalBytes) {
        throw new Error(`generated asset total size limit is ${GENERATED_ASSET_LIMITS.maxTotalBytes} bytes`);
      }
      totalBytes += size;
      files[targetPath] = content;
      items.push({
        id: asset.id || "",
        name: asset.name || targetPath,
        kind: asset.kind || "binary",
        mime: asset.mime || "",
        size,
        sha256: asset.sha256 || crypto.createHash("sha256").update(content).digest("hex"),
        path: targetPath,
        project_path: asset.project_path || "",
        usage: normalizeUsage(asset.usage || inferredUsage(asset)),
        use: asset.summary?.use || suggestedUse(asset.kind, path.posix.extname(asset.name || "").toLowerCase()),
      });
    } catch (error) {
      rejected.push({
        id: asset?.id || "",
        name: asset?.name || "asset",
        kind: asset?.kind || "binary",
        error: error.message,
      });
    }
  }

  return {
    files,
    items,
    manifestAssets: items.map(item => item.path),
    rejected,
    summary: {
      count: items.length,
      totalBytes,
    },
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

export function analyzeAsset({ name, mime, kind, ext, size, sha256, textPreview = "", buffer = Buffer.alloc(0), documentProfile = null, designProfile = null }) {
  const compact = textPreview ? compactText(textPreview) : "";
  const mediaProfile = analyzeMediaProfile({ name, mime, kind, ext, size, buffer, text: compact });
  const docProfile = documentProfile || analyzeDocumentProfile({ name, mime, kind, ext, size, buffer });
  const visualProfile = designProfile || analyzeDesignProfile({ name, mime, kind, ext, size, buffer, text: compact });
  const insights = extractAssetInsights({ name, mime, kind, ext, text: compact, mediaProfile, documentProfile: docProfile, designProfile: visualProfile });
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
    insights,
    mediaProfile,
    documentProfile: docProfile,
    designProfile: visualProfile,
  };

  if (compact) {
    summary.textPreview = compact.slice(0, 1200);
    summary.signals = extractTextSignals(compact);
  }
  summary.signals = uniqueStrings([...summary.signals, ...insights.signals]);

  if (kind === "archive") {
    summary.signals.push("Archive uploaded. Supported ZIP, TAR, TGZ, and GZ files are unpacked into separate analyzed assets.");
  }
  if (kind === "component" && [".html", ".htm"].includes(ext)) {
    summary.signals.push("HTML component can inform layout, but generated hardware app must still be self-contained and contract-safe.");
  }
  if (kind === "video") summary.signals.push("Video can be used as visual reference or compressed media for the 480x360 screen.");
  if (kind === "audio") summary.signals.push("Audio can support startup sounds, alerts, voice UI, or ambience when hardware audio is available.");
  if (kind === "document") summary.signals.push("Document can seed product copy, slide structure, spreadsheet fields, or design requirements without executing uploaded content.");
  if (kind === "design") summary.signals.push("Design source can guide visual identity, layout, component hierarchy, and palette without being embedded or executed.");
  if (mediaProfile.summary) summary.signals.push(mediaProfile.summary);
  if (docProfile.summary) summary.signals.push(docProfile.summary);
  if (visualProfile.summary) summary.signals.push(visualProfile.summary);
  return summary;
}

export function unpackArchiveAssets(buffer, archiveName = "assets.zip", archiveFormat = archiveFormatFromName(archiveName)) {
  if (archiveFormat === "zip") return unpackZipAssets(buffer, archiveName);
  if (archiveFormat === "tar") return unpackTarAssets(buffer, archiveName);
  if (archiveFormat === "tgz") {
    try {
      const tarBuffer = zlib.gunzipSync(buffer, {
        maxOutputLength: ASSET_LIBRARY_LIMITS.maxArchiveExpandedBytes,
      });
      return unpackTarAssets(tarBuffer, archiveName);
    } catch (error) {
      return { assets: [], rejected: [{ name: archiveName, error: `TGZ decompress failed: ${error.message}` }] };
    }
  }
  if (archiveFormat === "gz") return unpackGzipAsset(buffer, archiveName);
  return { assets: [], rejected: [] };
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

export function unpackTarAssets(buffer, archiveName = "assets.tar") {
  const assets = [];
  const rejected = [];
  let offset = 0;
  let expandedBytes = 0;
  const prefix = archivePrefix(archiveName);

  while (offset + 512 <= buffer.length && assets.length + rejected.length < ASSET_LIBRARY_LIMITS.maxArchiveEntries) {
    const header = buffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;

    const rawName = tarEntryName(header);
    const sizeText = readTarString(header, 124, 12).trim().replace(/\0.*$/, "");
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    const typeFlag = readTarString(header, 156, 1) || "0";
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    offset = nextOffset;

    if (!rawName || typeFlag === "5") continue;
    if (!Number.isFinite(size) || size < 0) {
      rejected.push({ name: rawName || archiveName, error: "invalid TAR entry size" });
      continue;
    }
    if (dataEnd > buffer.length) {
      rejected.push({ name: rawName, error: "TAR entry extends beyond archive size" });
      break;
    }
    if (typeFlag && typeFlag !== "0" && typeFlag !== "\0") {
      rejected.push({ name: rawName, error: `unsupported TAR entry type ${JSON.stringify(typeFlag)}` });
      continue;
    }

    try {
      const safeName = safeArchiveEntryName(rawName, prefix);
      if (size > ASSET_LIBRARY_LIMITS.maxArchiveEntryBytes) {
        throw new Error(`entry exceeds ${ASSET_LIBRARY_LIMITS.maxArchiveEntryBytes} bytes`);
      }
      if (expandedBytes + size > ASSET_LIBRARY_LIMITS.maxArchiveExpandedBytes) {
        throw new Error(`expanded archive exceeds ${ASSET_LIBRARY_LIMITS.maxArchiveExpandedBytes} bytes`);
      }
      const content = buffer.subarray(dataStart, dataEnd);
      expandedBytes += content.byteLength;
      assets.push(assetFromArchiveEntry(safeName, content));
    } catch (error) {
      rejected.push({ name: rawName, error: error.message });
    }
  }

  if (assets.length + rejected.length >= ASSET_LIBRARY_LIMITS.maxArchiveEntries) {
    rejected.push({ name: archiveName, error: `archive entry limit is ${ASSET_LIBRARY_LIMITS.maxArchiveEntries}` });
  }
  return { assets, rejected };
}

export function unpackGzipAsset(buffer, archiveName = "asset.gz") {
  try {
    const content = zlib.gunzipSync(buffer, {
      maxOutputLength: ASSET_LIBRARY_LIMITS.maxArchiveEntryBytes,
    });
    const prefix = archivePrefix(archiveName);
    const innerName = gzipInnerName(archiveName);
    const safeName = safeArchiveEntryName(innerName, prefix);
    return { assets: [assetFromArchiveEntry(safeName, content)], rejected: [] };
  } catch (error) {
    return { assets: [], rejected: [{ name: archiveName, error: `GZ decompress failed: ${error.message}` }] };
  }
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
    designBrief: buildAssetDesignBrief(list, byKind),
    items: list.slice(0, 24).map(asset => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      size: asset.size,
      usage: normalizeUsage(asset.usage || inferredUsage(asset)),
      folder_id: asset.folder_id || defaultFolderIdForKind(asset.conversation_id || "", asset.kind),
      project_path: asset.project_path || "",
      use: asset.summary?.use || suggestedUse(asset.kind, path.posix.extname(asset.name).toLowerCase()),
      signals: (asset.summary?.signals || []).slice(0, 4),
      textPreview: asset.summary?.textPreview || "",
      insights: compactPublicInsights(asset.summary?.insights || {}),
      mediaProfile: compactMediaProfile(asset.summary?.mediaProfile || {}),
      documentProfile: compactDocumentProfile(asset.summary?.documentProfile || {}),
      designProfile: compactDesignProfile(asset.summary?.designProfile || {}),
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
  if (summary.designBrief?.priorities?.length) {
    lines.push("Inferred product design brief from assets:");
    for (const priority of summary.designBrief.priorities.slice(0, 6)) lines.push(`  priority: ${priority}`);
    for (const reference of summary.designBrief.references.slice(0, 4)) lines.push(`  reference: ${reference}`);
    for (const constraint of summary.designBrief.constraints.slice(0, 4)) lines.push(`  constraint: ${constraint}`);
    for (const color of summary.designBrief.palette.slice(0, 6)) lines.push(`  palette: ${color}`);
    for (const component of summary.designBrief.components.slice(0, 6)) lines.push(`  component: ${component}`);
    for (const cta of summary.designBrief.ctas.slice(0, 4)) lines.push(`  cta: ${cta}`);
    for (const field of summary.designBrief.dataFields.slice(0, 8)) lines.push(`  data-field: ${field}`);
    for (const intent of summary.designBrief.productIntents.slice(0, 5)) lines.push(`  product-intent: ${intent}`);
    for (const layout of summary.designBrief.layoutPlan.slice(0, 5)) lines.push(`  layout-plan: ${layout}`);
    for (const media of summary.designBrief.mediaPlan.slice(0, 5)) lines.push(`  media-plan: ${media}`);
    for (const profile of summary.designBrief.mediaProfiles.slice(0, 8)) lines.push(`  media-profile: ${profile}`);
    for (const profile of summary.designBrief.documentProfiles.slice(0, 8)) lines.push(`  document-profile: ${profile}`);
    for (const profile of summary.designBrief.designProfiles.slice(0, 8)) lines.push(`  design-profile: ${profile}`);
    for (const gap of summary.designBrief.completionGaps.slice(0, 4)) lines.push(`  completion-gap: ${gap}`);
    for (const interaction of summary.designBrief.interactions.slice(0, 5)) lines.push(`  interaction: ${interaction}`);
  }
  for (const item of summary.items) {
    lines.push(`- ${item.name} (${item.kind}, ${item.size} bytes): ${item.use}`);
    for (const signal of item.signals.slice(0, 2)) lines.push(`  signal: ${signal}`);
    for (const color of (item.insights?.colors || []).slice(0, 3)) lines.push(`  color: ${color}`);
    for (const cta of (item.insights?.ctas || []).slice(0, 2)) lines.push(`  cta: ${cta}`);
    for (const field of (item.insights?.dataFields || []).slice(0, 4)) lines.push(`  data-field: ${field}`);
    if (item.mediaProfile?.summary) lines.push(`  media-profile: ${item.mediaProfile.summary}`);
    if (item.documentProfile?.summary) lines.push(`  document-profile: ${item.documentProfile.summary}`);
    if (item.designProfile?.summary) lines.push(`  design-profile: ${item.designProfile.summary}`);
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

function ensureColumn(db, table, column, type) {
  const rows = query(db, `PRAGMA table_info(${table})`);
  if (rows.some(row => row.name === column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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

function publicAssetRow(row = {}, folderScopeId = "") {
  let summary = {};
  try {
    summary = typeof row.summary_json === "string" ? JSON.parse(row.summary_json) : row.summary || {};
  } catch {}
  return publicAsset({ ...row, summary }, folderScopeId);
}

function storedAssetRow(row = {}) {
  return {
    ...publicAssetRow(row),
    encoding: row.encoding || BINARY_ENCODING,
    content: row.content || "",
  };
}

function publicAsset(asset = {}, folderScopeId = "") {
  const folderConversationId = folderScopeId || asset.conversation_id || "";
  return {
    id: asset.id,
    conversation_id: asset.conversation_id || "",
    name: asset.name,
    mime: asset.mime || "",
    kind: asset.kind,
    size: Number(asset.size || 0),
    sha256: asset.sha256,
    usage: normalizeUsage(asset.usage || inferredUsage(asset)),
    folder_id: asset.folder_id || asset.folderId || defaultFolderIdForKind(folderConversationId, asset.kind),
    project_path: asset.project_path || asset.projectPath || "",
    summary: asset.summary || {},
    created_at: asset.created_at || "",
  };
}

function publicFolderRow(row = {}) {
  return {
    id: row.id || "",
    conversation_id: row.conversation_id || "",
    name: row.name || "文件夹",
    category: row.category || "custom",
    system: Boolean(Number(row.system || 0)),
    asset_count: Number(row.asset_count || 0),
    total_bytes: Number(row.total_bytes || 0),
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
  };
}

function normalizeUsage(value) {
  const usage = String(value || "auto").trim();
  if (["auto", "embeddable", "reference_only", "ignored", "used_in_build"].includes(usage)) return usage;
  return "auto";
}

function inferredUsage(asset = {}) {
  if (asset.usage && asset.usage !== "auto") return normalizeUsage(asset.usage);
  if (GENERATED_ASSET_KINDS.has(asset.kind)) return "embeddable";
  return "reference_only";
}

function sanitizeAssetName(value) {
  const raw = String(value || "asset").replaceAll("\\", "/").split("/").pop().trim();
  const safe = sanitizeAssetSegment(raw).slice(0, 120);
  return safe || "asset";
}

function sanitizeFolderName(value) {
  const raw = String(value || "新建文件夹").replaceAll("\\", "/").split("/").pop().trim();
  const safe = sanitizeAssetSegment(raw).slice(0, 80);
  return safe || "新建文件夹";
}

function scopedFolderId(conversationId = "", folderId = "") {
  return `${conversationId}:${folderId}`;
}

function defaultFolderIdForKind(conversationId = "", kind = "") {
  const category = kind === "image" ? "image"
    : kind === "video" ? "video"
    : kind === "audio" ? "audio"
    : "other";
  const folder = DEFAULT_ASSET_FOLDERS.find(item => item.category === category) || DEFAULT_ASSET_FOLDERS[3];
  return scopedFolderId(conversationId, folder.id);
}

function sanitizeAssetPathName(value) {
  const normalized = path.posix.normalize(String(value || "asset").replaceAll("\\", "/"));
  const parts = normalized.split("/").map(part => sanitizeAssetSegment(part)).filter(Boolean);
  return parts.join("/") || "asset";
}

function generatedAssetPath(asset = {}, usedPaths = new Set()) {
  if (normalizeUsage(asset.usage) === "ignored") {
    throw new Error(`${asset.name || "asset"} is marked ignored`);
  }
  if (normalizeUsage(asset.usage) === "reference_only") {
    throw new Error(`${asset.name || "asset"} remains a design reference only`);
  }
  if (!GENERATED_ASSET_KINDS.has(asset.kind)) {
    throw new Error(`${asset.name || "asset"} is ${asset.kind || "binary"} and remains a design reference only`);
  }
  const safeName = sanitizeAssetPathName(asset.name || asset.id || "asset");
  const ext = path.posix.extname(safeName).toLowerCase();
  if (!ALLOWED_ASSET_EXTENSIONS.includes(ext)) {
    throw new Error(`asset extension is not embeddable in generated builds: ${ext || "(none)"}`);
  }

  const normalized = normalizeAssetPath(`${GENERATED_ASSET_LIMITS.root}/${safeName}`);
  if (!usedPaths.has(normalized)) {
    usedPaths.add(normalized);
    return normalized;
  }

  const suffix = String(asset.sha256 || crypto.createHash("sha256").update(safeName).digest("hex")).slice(0, 8);
  const dir = path.posix.dirname(normalized);
  const base = path.posix.basename(normalized, ext);
  for (let index = 0; index < 100; index += 1) {
    const infix = index === 0 ? suffix : `${suffix}-${index + 1}`;
    const deduped = normalizeAssetPath(`${dir}/${base}-${infix}${ext}`);
    if (!usedPaths.has(deduped)) {
      usedPaths.add(deduped);
      return deduped;
    }
  }
  throw new Error(`could not create a unique generated path for ${asset.name || "asset"}`);
}

function decodeStoredAssetContent(asset = {}) {
  if (!asset.content) throw new Error(`${asset.name || "asset"} has no stored content`);
  return decodeAssetContent(String(asset.content || ""), String(asset.encoding || BINARY_ENCODING).toLowerCase());
}

function archivePrefix(value) {
  const base = sanitizeAssetName(String(value || "archive").replace(/\.(zip|tar|tgz|tar\.gz|gz)$/i, ""));
  return base || "archive";
}

function archiveFormatFromName(name = "") {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".tgz") || lower.endsWith(".tar.gz")) return "tgz";
  if (lower.endsWith(".gz")) return "gz";
  return "";
}

function assetFromArchiveEntry(name, content) {
  return normalizeIncomingAsset({
    name,
    mime: mimeFromName(name),
    encoding: BINARY_ENCODING,
    content: content.toString(BINARY_ENCODING),
    preservePath: true,
  });
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

function isZeroBlock(buffer) {
  for (const byte of buffer) {
    if (byte !== 0) return false;
  }
  return true;
}

function readTarString(buffer, offset, length) {
  return buffer.toString("utf8", offset, offset + length).replace(/\0+$/g, "").trim();
}

function tarEntryName(header) {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function gzipInnerName(archiveName = "asset.gz") {
  const stripped = String(archiveName || "asset.gz").replace(/\.gz$/i, "");
  const base = stripped && stripped !== archiveName ? stripped : "asset";
  return sanitizeAssetName(base);
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
  if ([".pdf"].includes(ext)) return "application/pdf";
  if ([".docx"].includes(ext)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if ([".pptx"].includes(ext)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if ([".xlsx"].includes(ext)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
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
  if (kind === "document") return "document reference for copy, requirements, slide flow, tables, or product structure";
  if (kind === "design") return "design reference for visual identity, component hierarchy, spacing, and layout direction";
  if (kind === "archive") return "asset bundle; supported ZIP/TAR/TGZ/GZ entries are unpacked and analyzed as separate assets";
  if (kind === "data") return "structured data source for labels, dashboards, or state displays";
  return `supporting binary asset${ext ? ` (${ext})` : ""}`;
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildAssetDesignBrief(assets = [], byKind = {}) {
  const signals = assets.flatMap(asset => asset.summary?.signals || []);
  const insights = mergeAssetInsights(assets.map(asset => asset.summary?.insights || {}));
  const mediaProfiles = assets.map(asset => asset.summary?.mediaProfile || {}).filter(profile => profile.summary);
  const documentProfiles = assets.map(asset => asset.summary?.documentProfile || {}).filter(profile => profile.summary);
  const designProfiles = assets.map(asset => asset.summary?.designProfile || {}).filter(profile => profile.summary);
  const previews = assets
    .map(asset => asset.summary?.textPreview || "")
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const priorities = [];
  const references = [];
  const constraints = [
    "Adapt uploaded materials into a self-contained 480x360 embedded hardware UI.",
    "Treat uploaded HTML/CSS/JS as design reference, not executable code.",
  ];

  if (byKind.image) {
    priorities.push("Use uploaded images as primary visual material, product photos, icons, textures, or compact slideshow frames.");
    references.push(`${byKind.image} image asset(s) can drive color, composition, and visual hierarchy.`);
  }
  if (byKind.video) {
    priorities.push("Use video assets as motion references or short compressed media moments only when they fit embedded playback limits.");
    references.push(`${byKind.video} video asset(s) suggest animation rhythm, scene cuts, or thumbnail states.`);
  }
  if (byKind.audio) {
    priorities.push("Map audio assets to lightweight sound cues, alerts, ambience, or voice interaction states when hardware audio is enabled.");
    references.push(`${byKind.audio} audio asset(s) can inform feedback sounds and mood.`);
  }
  if (byKind.component) {
    priorities.push("Translate uploaded components into contract-safe local HTML/CSS patterns for the generated app.");
    references.push(`${byKind.component} component asset(s) can inform layout, controls, spacing, and interaction affordances.`);
  }
  if (byKind.text || byKind.data) {
    priorities.push("Extract copy, labels, metrics, structured values, and dashboard content from text/data assets.");
    references.push(`${(byKind.text || 0) + (byKind.data || 0)} text/data asset(s) can seed content and state labels.`);
  }
  if (byKind.font) {
    priorities.push("Use font assets as typography direction while keeping generated UI readable on 480x360.");
  }
  if (byKind.document) {
    priorities.push("Extract product requirements, slide structure, spreadsheet fields, and presentation copy from uploaded documents.");
    references.push(`${byKind.document} document asset(s) can seed product copy, sections, spreadsheet metrics, or storyboard flow.`);
  }
  if (byKind.design) {
    priorities.push("Use uploaded design source files as visual direction for layout, component hierarchy, palette, spacing, and brand tone.");
    references.push(`${byKind.design} design asset(s) can guide the generated 480x360 UI without being embedded or executed.`);
  }
  if (byKind.archive) {
    references.push("Archive assets indicate a bundled product kit; use extracted entries as the real design source.");
  }
  for (const profile of mediaProfiles.slice(0, 8)) {
    references.push(profile.summary);
  }
  for (const profile of documentProfiles.slice(0, 8)) {
    references.push(profile.summary);
  }
  for (const profile of designProfiles.slice(0, 8)) {
    references.push(profile.summary);
  }

  if (signals.some(signal => signal.includes("visual identity")) || /(brand|logo|palette|品牌|色彩|视觉)/i.test(previews)) {
    priorities.push("Preserve brand identity signals such as palette, logo usage, typography, and visual tone.");
  }
  if (insights.colors.length) {
    priorities.push(`Apply extracted palette cues such as ${insights.colors.slice(0, 5).join(", ")} with enough contrast for the small screen.`);
    references.push(`Palette cues were extracted from uploaded text/components: ${insights.colors.slice(0, 8).join(", ")}.`);
  }
  if (insights.components.length) {
    priorities.push(`Adapt detected component structure (${insights.components.slice(0, 6).join(", ")}) into a polished 480x360 layout.`);
  }
  if (insights.ctas.length) {
    priorities.push(`Surface primary calls to action such as ${insights.ctas.slice(0, 4).join(", ")} as concise button or status states.`);
  }
  if (insights.dataFields.length) {
    priorities.push(`Use extracted data fields (${insights.dataFields.slice(0, 8).join(", ")}) as dashboard labels, cards, or telemetry rows.`);
  }
  if (insights.interactions.length) {
    references.push(`Interaction cues: ${insights.interactions.slice(0, 6).join(", ")}.`);
  }
  if (signals.some(signal => signal.includes("dashboard")) || /(dashboard|metric|sensor|status|数据|指标|监控)/i.test(previews)) {
    priorities.push("Prefer glanceable dashboard layout with strong hierarchy for status, metrics, and alerts.");
  }
  if (signals.some(signal => signal.includes("audio")) || /(audio|music|sound|voice|音乐|音效|语音)/i.test(previews)) {
    priorities.push("Expose audio state clearly in the UI: play/pause, volume, cue status, or voice-ready feedback.");
  }
  if (signals.some(signal => signal.includes("motion")) || /(video|motion|animation|动画|视频|动效)/i.test(previews)) {
    priorities.push("Represent motion through lightweight animation states, progress, thumbnails, or timeline cues.");
  }

  const productIntents = inferProductIntents({ byKind, insights, mediaProfiles, documentProfiles, designProfiles, previews, signals });
  const layoutPlan = buildLayoutPlan({ byKind, insights, mediaProfiles, documentProfiles, designProfiles, productIntents });
  const completionGaps = inferCompletionGaps({ byKind, insights, mediaProfiles, documentProfiles, designProfiles, productIntents });

  if (!priorities.length) {
    priorities.push("Use uploaded file names, types, and previews as creative direction for a polished embedded product screen.");
  }
  for (const intent of productIntents.slice(0, 3)) {
    priorities.push(`Default product direction from assets: ${intent}.`);
  }

  return {
    priorities: uniqueStrings(priorities).slice(0, 8),
    references: uniqueStrings(references).slice(0, 8),
    constraints,
    palette: insights.colors.slice(0, 10),
    components: insights.components.slice(0, 10),
    ctas: insights.ctas.slice(0, 8),
    dataFields: insights.dataFields.slice(0, 12),
    productIntents,
    layoutPlan,
    mediaPlan: buildMediaPlan(byKind, insights, mediaProfiles).slice(0, 8),
    mediaProfiles: mediaProfiles.map(profile => profile.summary).slice(0, 12),
    documentProfiles: documentProfiles.map(profile => profile.summary).slice(0, 12),
    designProfiles: designProfiles.map(profile => profile.summary).slice(0, 12),
    completionGaps,
    interactions: insights.interactions.slice(0, 10),
  };
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

function extractAssetInsights({ name = "", mime = "", kind = "", ext = "", text = "", mediaProfile = {}, documentProfile = {}, designProfile = {} } = {}) {
  const source = String(text || "");
  const lowerName = String(name || "").toLowerCase();
  const colors = extractColors(source);
  const components = extractComponents(source);
  const ctas = extractCtas(source);
  const dataFields = extractDataFields(source, ext);
  const interactions = extractInteractions(source);
  const signals = [];

  if (colors.length) signals.push(`Extracted palette cues: ${colors.slice(0, 5).join(", ")}.`);
  if (components.length) signals.push(`Detected UI structure: ${components.slice(0, 5).join(", ")}.`);
  if (ctas.length) signals.push(`Detected CTA/copy cues: ${ctas.slice(0, 4).join(", ")}.`);
  if (dataFields.length) signals.push(`Detected data fields: ${dataFields.slice(0, 6).join(", ")}.`);
  if (interactions.length) signals.push(`Detected interaction cues: ${interactions.slice(0, 5).join(", ")}.`);
  if (kind === "image" || /(hero|photo|logo|cover|banner|product|icon|照片|图片|封面|产品|图标)/i.test(lowerName)) {
    signals.push("Image naming suggests direct visual placement, branding, or product hero use.");
  }
  if (kind === "font") signals.push("Font asset can inform typography hierarchy if converted into local CSS safely.");
  if (kind === "video") signals.push("Video asset should be represented as thumbnail, loop, timeline, or motion state on the 480x360 UI.");
  if (kind === "audio") signals.push("Audio asset should map to a playback/status/voice feedback control if useful.");
  if (mediaProfile.summary) signals.push(mediaProfile.summary);
  if (documentProfile.summary) signals.push(documentProfile.summary);
  if (designProfile.summary) signals.push(designProfile.summary);
  if (String(mime || "").includes("json") || ext === ".json") signals.push("JSON asset can seed structured dashboard content.");
  if (kind === "document") signals.push("Document asset can seed product sections, copy, metrics, or storyboard content.");
  if (kind === "design") signals.push("Design source should inform brand tone, component shape, hierarchy, and visual polish.");

  return {
    colors,
    components,
    ctas,
    dataFields,
    interactions,
    signals: uniqueStrings(signals).slice(0, 8),
  };
}

function extractColors(text = "") {
  const colors = [];
  const raw = String(text || "");
  for (const match of raw.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) colors.push(match[0]);
  for (const match of raw.matchAll(/\b(?:rgb|rgba|hsl|hsla)\(\s*[^)]+\)/gi)) colors.push(match[0].replace(/\s+/g, " "));
  const named = raw.match(/\b(?:cyan|teal|blue|navy|purple|violet|magenta|pink|red|orange|amber|yellow|green|lime|black|white|gray|grey|slate|indigo|gold|silver|bronze|emerald|rose|sky)\b/gi) || [];
  colors.push(...named.map(item => item.toLowerCase()));
  const chinese = raw.match(/(?:青色|蓝色|紫色|粉色|红色|橙色|黄色|绿色|黑色|白色|灰色|金色|银色|品牌色|主色|辅助色)/g) || [];
  colors.push(...chinese);
  return uniqueStrings(colors).slice(0, 16);
}

function extractComponents(text = "") {
  const raw = String(text || "");
  const components = [];
  for (const match of raw.matchAll(/<\s*(section|article|main|header|footer|nav|aside|button|canvas|video|audio|img|form|input|select|table|ul|ol|li|card|dialog)\b/gi)) {
    components.push(match[1].toLowerCase());
  }
  const classMatches = raw.matchAll(/\bclass\s*=\s*["']([^"']{1,120})["']/gi);
  for (const match of classMatches) {
    const names = String(match[1] || "").split(/\s+/).filter(Boolean);
    for (const name of names) {
      if (/(card|hero|panel|toolbar|button|metric|status|chart|player|control|nav|grid|list|tile|modal|badge)/i.test(name)) {
        components.push(name.toLowerCase());
      }
    }
  }
  const words = raw.match(/\b(?:hero|card|panel|toolbar|button|metric|status|chart|player|timeline|grid|list|tile|badge|modal|carousel|slider)\b/gi) || [];
  components.push(...words.map(item => item.toLowerCase()));
  return uniqueStrings(components).slice(0, 18);
}

function extractCtas(text = "") {
  const raw = String(text || "");
  const ctas = [];
  for (const match of raw.matchAll(/<button[^>]*>([^<]{1,40})<\/button>/gi)) ctas.push(compactText(match[1]));
  for (const match of raw.matchAll(/\b(?:cta|button|按钮|操作|action)\s*[:=：]\s*["']?([^"',\n\r。；;]{1,40})/gi)) ctas.push(compactText(match[1]));
  const quoted = raw.match(/(?:立即开始|开始体验|播放|暂停|部署|查看详情|购买|连接设备|刷新|确认|Start|Play|Pause|Deploy|Details|Connect|Refresh|Confirm|Buy Now|Try Now)/g) || [];
  ctas.push(...quoted);
  return uniqueStrings(ctas).slice(0, 12);
}

function extractDataFields(text = "", ext = "") {
  const raw = String(text || "");
  const fields = [];
  for (const match of raw.matchAll(/["']?([A-Za-z_][\w.-]{1,32}|[\u4e00-\u9fff]{2,12})["']?\s*:/g)) {
    fields.push(match[1]);
  }
  if ([".csv", ".tsv"].includes(ext)) {
    const firstLine = raw.split(/\r?\n/).find(line => line.trim()) || "";
    const delimiter = ext === ".tsv" ? "\t" : ",";
    for (const field of firstLine.split(delimiter)) fields.push(compactText(field).slice(0, 32));
  }
  const labeled = raw.match(/\b(?:temperature|humidity|speed|battery|status|price|volume|progress|score|count|total|cpu|memory|latency|温度|湿度|速度|电量|状态|价格|音量|进度|评分|数量|总数|内存|延迟)\b/gi) || [];
  fields.push(...labeled);
  return uniqueStrings(fields).filter(field => field.length >= 2).slice(0, 24);
}

function extractInteractions(text = "") {
  const raw = String(text || "");
  const interactions = [];
  const matches = raw.match(/\b(?:click|tap|hover|drag|swipe|scroll|play|pause|record|stop|toggle|select|filter|refresh|deploy|confirm|点击|轻触|滑动|播放|暂停|录音|停止|切换|选择|筛选|刷新|部署|确认)\b/gi) || [];
  interactions.push(...matches.map(item => item.toLowerCase()));
  if (/<audio\b/i.test(raw)) interactions.push("audio playback");
  if (/<video\b/i.test(raw)) interactions.push("video playback");
  if (/<canvas\b/i.test(raw)) interactions.push("canvas visualization");
  if (/<form\b|<input\b|<select\b/i.test(raw)) interactions.push("form controls");
  return uniqueStrings(interactions).slice(0, 16);
}

function mergeAssetInsights(insightList = []) {
  return {
    colors: uniqueStrings(insightList.flatMap(item => item.colors || [])).slice(0, 16),
    components: uniqueStrings(insightList.flatMap(item => item.components || [])).slice(0, 18),
    ctas: uniqueStrings(insightList.flatMap(item => item.ctas || [])).slice(0, 12),
    dataFields: uniqueStrings(insightList.flatMap(item => item.dataFields || [])).slice(0, 24),
    interactions: uniqueStrings(insightList.flatMap(item => item.interactions || [])).slice(0, 16),
  };
}

function compactPublicInsights(insights = {}) {
  return {
    colors: uniqueStrings(insights.colors || []).slice(0, 8),
    components: uniqueStrings(insights.components || []).slice(0, 8),
    ctas: uniqueStrings(insights.ctas || []).slice(0, 6),
    dataFields: uniqueStrings(insights.dataFields || []).slice(0, 8),
    interactions: uniqueStrings(insights.interactions || []).slice(0, 8),
  };
}

function inferProductIntents({ byKind = {}, insights = {}, mediaProfiles = [], documentProfiles = [], designProfiles = [], previews = "", signals = [] } = {}) {
  const intents = [];
  const documentText = documentProfiles.map(profile => `${profile.summary || ""} ${profile.tags?.join(" ") || ""}`).join(" ");
  const designText = designProfiles.map(profile => `${profile.summary || ""} ${profile.tags?.join(" ") || ""}`).join(" ");
  const text = `${previews} ${signals.join(" ")} ${insights.components?.join(" ") || ""} ${insights.dataFields?.join(" ") || ""} ${documentText} ${designText}`.toLowerCase();
  const hasHeroImage = mediaProfiles.some(profile => profile.kind === "image" && /hero|brand mark|screen-scale source|product|logo/i.test(`${profile.summary || ""} ${profile.tags?.join(" ") || ""}`));
  const hasAudio = Boolean(byKind.audio) || /audio|music|sound|voice|音乐|音效|语音/.test(text);
  const hasVideo = Boolean(byKind.video) || /video|motion|animation|timeline|视频|动画|动效/.test(text);
  const hasDashboard = Boolean(byKind.data) || insights.dataFields?.length || /dashboard|metric|sensor|status|telemetry|monitor|数据|指标|监控|状态/.test(text);
  const hasControls = insights.ctas?.length || insights.interactions?.length || /button|control|connect|deploy|play|pause|refresh|toggle|按钮|控制|连接|播放|暂停|刷新/.test(text);
  const hasBrand = insights.colors?.length || /brand|logo|palette|typography|品牌|色彩|视觉|字体/.test(text);

  if (hasHeroImage && hasBrand) intents.push("brand/product showcase screen with hero visual, palette, and concise CTA");
  if (hasDashboard) intents.push("glanceable data dashboard for status, metrics, and telemetry");
  if (hasAudio || hasVideo) intents.push("media controller screen with playback state, cue feedback, and motion thumbnail");
  if (hasControls) intents.push("hardware control panel with clear primary action and status feedback");
  if (documentProfiles.some(profile => profile.kind === "presentation")) intents.push("slide/storyboard summary screen adapted from uploaded presentation");
  if (documentProfiles.some(profile => profile.kind === "spreadsheet")) intents.push("spreadsheet-backed dashboard with key rows, columns, and metrics");
  if (documentProfiles.some(profile => profile.kind === "document")) intents.push("document-backed product brief screen with extracted sections and copy");
  if (designProfiles.length) intents.push("design-system-led embedded screen using uploaded visual source as style direction");
  if (byKind.archive && (byKind.component || byKind.image || byKind.text)) intents.push("bundled product kit adapted into one coherent 480x360 embedded app");
  if (!intents.length && (byKind.image || byKind.text || byKind.component)) intents.push("compact product information screen inferred from uploaded copy and visuals");
  return uniqueStrings(intents).slice(0, 6);
}

function buildLayoutPlan({ byKind = {}, insights = {}, mediaProfiles = [], documentProfiles = [], designProfiles = [], productIntents = [] } = {}) {
  const plan = [];
  const intentText = productIntents.join(" ").toLowerCase();
  const wideImage = mediaProfiles.find(profile => profile.kind === "image" && profile.width && profile.height && profile.width / profile.height >= 1.25);
  const squareImage = mediaProfiles.find(profile => profile.kind === "image" && profile.width && profile.height && Math.abs(profile.width / profile.height - 1) < 0.08);
  const dataCount = Array.isArray(insights.dataFields) ? insights.dataFields.length : 0;

  if (wideImage) plan.push(`Use ${wideImage.name || "the widest image"} as a top hero band or full-bleed background crop with readable overlays.`);
  else if (squareImage) plan.push(`Place ${squareImage.name || "the square image"} as a large left hero/logo block with content stacked on the right.`);
  else if (byKind.image) plan.push("Reserve the strongest image asset for the first visual focus; keep text in a separate high-contrast zone.");

  if (intentText.includes("dashboard") || dataCount >= 3) {
    plan.push(`Use a compact dashboard grid with ${Math.min(Math.max(dataCount, 3), 6)} metric/status tiles and one highlighted primary state.`);
  }
  if (documentProfiles.some(profile => profile.kind === "presentation")) {
    plan.push("Convert presentation structure into a short storyboard: title, 2-3 key slide points, and one action/status row.");
  }
  if (documentProfiles.some(profile => profile.kind === "spreadsheet")) {
    plan.push("Turn spreadsheet rows/columns into compact metric cards or a two-column comparison table.");
  }
  if (documentProfiles.some(profile => profile.kind === "document")) {
    plan.push("Use document headings and extracted copy as concise sections rather than long paragraphs.");
  }
  if (designProfiles.length) {
    plan.push("Translate uploaded design source cues into a contract-safe 480x360 layout with explicit spacing, hierarchy, and reusable component shapes.");
  }
  if (intentText.includes("media") || byKind.audio || byKind.video) {
    plan.push("Add a small media/status strip for play state, progress, volume/cue, or motion thumbnail.");
  }
  if (insights.ctas?.length || intentText.includes("control")) {
    plan.push("Pin the primary action in a stable bottom control row with one secondary status/action at most.");
  }
  if (insights.colors?.length) {
    plan.push("Build the visual system from extracted palette cues while preserving contrast on the 480x360 screen.");
  }
  if (!plan.length) plan.push("Use a simple 480x360 hierarchy: header, primary visual/content area, and compact bottom status/action row.");
  return uniqueStrings(plan).slice(0, 8);
}

function inferCompletionGaps({ byKind = {}, insights = {}, mediaProfiles = [], documentProfiles = [], designProfiles = [], productIntents = [] } = {}) {
  const gaps = [];
  const intentText = productIntents.join(" ").toLowerCase();
  if (!byKind.image && !byKind.video) gaps.push("No visual media was uploaded; generate a clean CSS-led visual system from text and data cues.");
  if (!insights.ctas?.length) gaps.push("No explicit CTA was found; choose one default hardware-friendly primary action.");
  if ((intentText.includes("dashboard") || byKind.data) && !insights.dataFields?.length) {
    gaps.push("Structured data exists but no clear fields were extracted; create readable placeholder metrics rather than asking again.");
  }
  if ((byKind.audio || byKind.video) && !mediaProfiles.some(profile => profile.durationSec != null || profile.width || profile.height)) {
    gaps.push("Some media lacks detailed dimensions/duration; represent it through safe poster/status states.");
  }
  if (byKind.document && !documentProfiles.some(profile => profile.textPreview)) {
    gaps.push("Uploaded documents expose limited extractable text; use filenames and document type as direction.");
  }
  if (byKind.design && !designProfiles.some(profile => profile.colors?.length)) {
    gaps.push("Design source does not expose parseable tokens; infer style from file names and keep generated UI contract-safe.");
  }
  if (!insights.colors?.length && !designProfiles.some(profile => profile.colors?.length)) gaps.push("No palette was extracted; derive a restrained palette from filenames, media role, and screen readability.");
  return uniqueStrings(gaps).slice(0, 6);
}

function analyzeDocumentProfile({ name = "", mime = "", kind = "", ext = "", size = 0, buffer = Buffer.alloc(0) } = {}) {
  if (kind !== "document") return { kind, summary: "", textPreview: "", tags: [] };
  const profile = {
    kind: documentKind(ext, mime),
    format: ext ? ext.slice(1) : mediaFormatFromMime(mime),
    pages: null,
    sheets: null,
    slides: null,
    textPreview: "",
    tags: [],
    summary: "",
  };

  if (ext === ".pdf") Object.assign(profile, pdfDocumentProfile(buffer));
  if ([".docx", ".pptx", ".xlsx"].includes(ext)) Object.assign(profile, officeDocumentProfile(buffer, ext));
  if (ext === ".rtf") profile.textPreview = compactText(buffer.toString("utf8", 0, Math.min(buffer.length, ASSET_LIBRARY_LIMITS.textPreviewBytes)).replace(/[{}\\][a-z0-9-]* ?/gi, " "));

  profile.tags.push(...documentNameTags(name, profile.kind));
  if (profile.textPreview) profile.tags.push("extractable text");
  if (profile.pages) profile.tags.push(`${profile.pages} page${profile.pages === 1 ? "" : "s"}`);
  if (profile.slides) profile.tags.push(`${profile.slides} slide${profile.slides === 1 ? "" : "s"}`);
  if (profile.sheets) profile.tags.push(`${profile.sheets} sheet${profile.sheets === 1 ? "" : "s"}`);
  profile.tags = uniqueStrings(profile.tags).slice(0, 10);
  profile.summary = documentSummary({ ...profile, name, size });
  return profile;
}

function documentKind(ext = "", mime = "") {
  if (ext === ".pptx" || ext === ".ppt") return "presentation";
  if (ext === ".xlsx" || ext === ".xls") return "spreadsheet";
  if (ext === ".pdf") return "pdf";
  if (String(mime || "").includes("presentation")) return "presentation";
  if (String(mime || "").includes("spreadsheet") || String(mime || "").includes("excel")) return "spreadsheet";
  return "document";
}

function pdfDocumentProfile(buffer = Buffer.alloc(0)) {
  const latin = buffer.toString("latin1", 0, Math.min(buffer.length, ASSET_LIBRARY_LIMITS.textPreviewBytes));
  const pages = (latin.match(/\/Type\s*\/Page\b/g) || []).length || null;
  const textPreview = extractReadableTokens(latin);
  return {
    pages,
    textPreview,
    tags: textPreview ? ["pdf text hints"] : ["pdf"],
  };
}

function officeDocumentProfile(buffer = Buffer.alloc(0), ext = "") {
  if (!buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return { tags: ["office container not readable"] };
  }
  const zip = readZipEntries(buffer);
  const names = Object.keys(zip);
  const xmlTexts = [];
  let slides = null;
  let sheets = null;
  if (ext === ".docx") {
    for (const name of names.filter(item => /^word\/(document|header|footer|footnotes|endnotes).*\.xml$/i.test(item))) {
      xmlTexts.push(extractXmlText(zip[name]));
    }
  }
  if (ext === ".pptx") {
    const slideNames = names.filter(item => /^ppt\/slides\/slide\d+\.xml$/i.test(item));
    slides = slideNames.length || null;
    for (const name of slideNames.slice(0, 12)) xmlTexts.push(extractXmlText(zip[name]));
  }
  if (ext === ".xlsx") {
    const sheetNames = names.filter(item => /^xl\/worksheets\/sheet\d+\.xml$/i.test(item));
    sheets = sheetNames.length || null;
    if (zip["xl/sharedStrings.xml"]) xmlTexts.push(extractXmlText(zip["xl/sharedStrings.xml"]));
    for (const name of sheetNames.slice(0, 6)) xmlTexts.push(extractXmlText(zip[name]));
  }

  const textPreview = compactText(xmlTexts.join(" ")).slice(0, 1200);
  return {
    slides,
    sheets,
    textPreview,
    tags: ["office xml"],
  };
}

function readZipEntries(buffer = Buffer.alloc(0)) {
  const entries = {};
  let offset = 0;
  while (offset + 30 <= buffer.length && Object.keys(entries).length < ASSET_LIBRARY_LIMITS.maxArchiveEntries) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;
    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if ((flags & 0x08) || dataEnd > buffer.length) break;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    offset = dataEnd;
    if (!name || name.endsWith("/")) continue;
    try {
      const content = inflateZipEntry(buffer.subarray(dataStart, dataEnd), method);
      if (content.byteLength <= ASSET_LIBRARY_LIMITS.textPreviewBytes * 4) entries[name] = content.toString("utf8");
    } catch {}
  }
  return entries;
}

function extractXmlText(xml = "") {
  const raw = String(xml || "");
  const texts = [];
  for (const match of raw.matchAll(/<[^:>]*:?t(?:\s[^>]*)?>([\s\S]*?)<\/[^:>]*:?t>/gi)) {
    texts.push(decodeXmlEntities(match[1]));
  }
  if (!texts.length) {
    for (const match of raw.matchAll(/<[^:>]*:?v(?:\s[^>]*)?>([\s\S]*?)<\/[^:>]*:?v>/gi)) {
      texts.push(decodeXmlEntities(match[1]));
    }
  }
  return compactText(texts.join(" ").replace(/<[^>]+>/g, " "));
}

function extractReadableTokens(value = "") {
  const matches = String(value || "").match(/[A-Za-z0-9][A-Za-z0-9 _.,:%#/\-]{2,80}|[\u4e00-\u9fff]{2,40}/g) || [];
  return compactText(matches.filter(item => !/^\/?[A-Z][A-Za-z]+$/.test(item)).slice(0, 80).join(" ")).slice(0, 1200);
}

function decodeXmlEntities(value = "") {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function documentNameTags(name = "", kind = "") {
  const lower = String(name || "").toLowerCase();
  const tags = [];
  if (/(brief|requirement|spec|prd|需求|说明|方案|文档)/i.test(lower)) tags.push("requirements source");
  if (/(slide|deck|ppt|presentation|演示|汇报|路演)/i.test(lower) || kind === "presentation") tags.push("storyboard source");
  if (/(sheet|table|excel|metrics|data|表格|数据|指标)/i.test(lower) || kind === "spreadsheet") tags.push("structured table source");
  return tags;
}

function documentSummary(profile = {}) {
  const parts = [];
  const label = profile.kind === "pdf" ? "PDF" : profile.kind === "presentation" ? "Presentation" : profile.kind === "spreadsheet" ? "Spreadsheet" : "Document";
  parts.push(`${label} ${profile.name || "asset"}`);
  if (profile.pages) parts.push(`${profile.pages} pages`);
  if (profile.slides) parts.push(`${profile.slides} slides`);
  if (profile.sheets) parts.push(`${profile.sheets} sheets`);
  if (profile.textPreview) parts.push(`text: ${profile.textPreview.slice(0, 120)}`);
  if (profile.tags?.length) parts.push(`tags: ${profile.tags.slice(0, 4).join(", ")}`);
  return parts.join("; ");
}

function compactDocumentProfile(profile = {}) {
  return {
    kind: profile.kind || "",
    format: profile.format || "",
    pages: profile.pages ?? null,
    sheets: profile.sheets ?? null,
    slides: profile.slides ?? null,
    textPreview: profile.textPreview || "",
    tags: Array.isArray(profile.tags) ? profile.tags.slice(0, 6) : [],
    summary: profile.summary || "",
  };
}

function analyzeDesignProfile({ name = "", mime = "", kind = "", ext = "", size = 0, buffer = Buffer.alloc(0), text = "" } = {}) {
  if (kind !== "design") return { kind, summary: "", textPreview: "", colors: [], components: [], tags: [] };
  const rawText = text || designTextPreview(buffer, ext);
  const colors = extractColors(rawText);
  const components = extractDesignComponents(rawText, name);
  const tags = uniqueStrings([
    ...designNameTags(name, ext),
    ...(colors.length ? ["design tokens"] : []),
    ...(components.length ? ["component hints"] : []),
  ]).slice(0, 10);
  const profile = {
    kind: designKind(ext, mime),
    format: ext ? ext.slice(1) : mediaFormatFromMime(mime),
    textPreview: compactText(rawText).slice(0, 1200),
    colors,
    components,
    tags,
    summary: "",
  };
  profile.summary = designSummary({ ...profile, name, size });
  return profile;
}

function designKind(ext = "", mime = "") {
  if (ext === ".fig") return "figma";
  if (ext === ".sketch") return "sketch";
  if (ext === ".psd") return "photoshop";
  if (ext === ".ai") return "illustrator";
  if (ext === ".xd") return "adobe-xd";
  if (String(mime || "").includes("json") || ext === ".tokens" || ext === ".design") return "design-tokens";
  return "design-source";
}

function designTextPreview(buffer = Buffer.alloc(0), ext = "") {
  if ([".tokens", ".design", ".ase", ".aco"].includes(ext)) {
    return buffer.toString("utf8", 0, Math.min(buffer.length, ASSET_LIBRARY_LIMITS.textPreviewBytes));
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (!sample.includes(0)) return sample.toString("utf8");
  return "";
}

function extractDesignComponents(text = "", name = "") {
  const raw = `${text || ""} ${name || ""}`;
  const components = [];
  const words = raw.match(/\b(?:button|card|panel|modal|hero|navbar|toolbar|tab|badge|avatar|chart|metric|player|timeline|grid|list|tile|control|slider|toggle|组件|按钮|卡片|面板|图表|指标|播放|控制)\b/gi) || [];
  components.push(...words.map(item => item.toLowerCase()));
  for (const match of raw.matchAll(/["']?(?:component|name|token|style)["']?\s*:\s*["']([^"']{2,48})["']/gi)) {
    components.push(compactText(match[1]).toLowerCase());
  }
  return uniqueStrings(components).slice(0, 12);
}

function designNameTags(name = "", ext = "") {
  const lower = String(name || "").toLowerCase();
  const tags = [];
  if (/(brand|logo|identity|视觉|品牌|标志)/i.test(lower)) tags.push("brand direction");
  if (/(system|tokens|theme|style|design|设计|组件|主题)/i.test(lower) || [".tokens", ".design"].includes(ext)) tags.push("design system");
  if (/(mobile|screen|ui|dashboard|panel|小屏|屏幕|看板|面板)/i.test(lower)) tags.push("screen layout source");
  return tags;
}

function designSummary(profile = {}) {
  const parts = [];
  parts.push(`Design ${profile.name || "asset"} (${profile.kind || "source"})`);
  if (profile.colors?.length) parts.push(`colors: ${profile.colors.slice(0, 6).join(", ")}`);
  if (profile.components?.length) parts.push(`components: ${profile.components.slice(0, 6).join(", ")}`);
  if (profile.tags?.length) parts.push(`tags: ${profile.tags.slice(0, 4).join(", ")}`);
  return parts.join("; ");
}

function compactDesignProfile(profile = {}) {
  return {
    kind: profile.kind || "",
    format: profile.format || "",
    textPreview: profile.textPreview || "",
    colors: Array.isArray(profile.colors) ? profile.colors.slice(0, 8) : [],
    components: Array.isArray(profile.components) ? profile.components.slice(0, 8) : [],
    tags: Array.isArray(profile.tags) ? profile.tags.slice(0, 6) : [],
    summary: profile.summary || "",
  };
}

function analyzeMediaProfile({ name = "", mime = "", kind = "", ext = "", size = 0, buffer = Buffer.alloc(0), text = "" } = {}) {
  if (!["image", "video", "audio", "font"].includes(kind)) {
    return { kind, summary: "", width: null, height: null, durationSec: null, tags: [] };
  }

  const profile = {
    kind,
    format: ext ? ext.slice(1) : mediaFormatFromMime(mime),
    width: null,
    height: null,
    aspect: "",
    durationSec: null,
    sampleRate: null,
    channels: null,
    bitrateKbps: null,
    tags: [],
    summary: "",
  };

  if (kind === "image") Object.assign(profile, imageProfile(buffer, ext, text));
  if (kind === "audio") Object.assign(profile, audioProfile(buffer, ext));
  if (kind === "video") Object.assign(profile, videoProfile(buffer, ext));
  if (kind === "font") profile.tags.push("typography asset");

  profile.tags.push(...mediaNameTags(name, kind));
  profile.tags = uniqueStrings(profile.tags).slice(0, 10);
  profile.summary = mediaSummary({ ...profile, name, size });
  return profile;
}

function imageProfile(buffer = Buffer.alloc(0), ext = "", text = "") {
  const dimensions = imageDimensions(buffer, ext, text);
  const tags = [];
  if (dimensions.width && dimensions.height) {
    const ratio = dimensions.width / dimensions.height;
    if (ratio > 1.4) tags.push("wide visual");
    else if (ratio < 0.75) tags.push("portrait visual");
    else tags.push("balanced visual");
    if (dimensions.width >= 480 || dimensions.height >= 360) tags.push("screen-scale source");
  }
  return {
    ...dimensions,
    aspect: dimensions.width && dimensions.height ? aspectLabel(dimensions.width, dimensions.height) : "",
    tags,
  };
}

function audioProfile(buffer = Buffer.alloc(0), ext = "") {
  const tags = [];
  const wav = ext === ".wav" ? wavProfile(buffer) : {};
  if (ext === ".mp3" && buffer.subarray(0, 3).toString("latin1") === "ID3") tags.push("mp3 id3 metadata");
  if (ext === ".ogg" && buffer.subarray(0, 4).toString("latin1") === "OggS") tags.push("ogg stream");
  if (wav.durationSec != null && wav.durationSec <= 6) tags.push("short sound cue");
  else if (wav.durationSec != null) tags.push("longer audio bed");
  return {
    durationSec: wav.durationSec ?? null,
    sampleRate: wav.sampleRate ?? null,
    channels: wav.channels ?? null,
    bitrateKbps: wav.bitrateKbps ?? null,
    tags,
  };
}

function videoProfile(buffer = Buffer.alloc(0), ext = "") {
  const tags = [];
  if (ext === ".webm" && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) tags.push("webm container");
  if ([".mp4", ".mov", ".m4v"].includes(ext) && buffer.includes(Buffer.from("ftyp"))) tags.push("mp4-family container");
  tags.push("use as poster/timeline/motion state");
  return { tags };
}

function imageDimensions(buffer = Buffer.alloc(0), ext = "", text = "") {
  if (ext === ".png" && buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if ((ext === ".jpg" || ext === ".jpeg") && buffer.length > 4) return jpegDimensions(buffer);
  if (ext === ".gif" && buffer.length >= 10 && buffer.subarray(0, 3).toString("latin1") === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (ext === ".webp" && buffer.length >= 30) return webpDimensions(buffer);
  if (ext === ".svg") return svgDimensions(text);
  return { width: null, height: null };
}

function jpegDimensions(buffer = Buffer.alloc(0)) {
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function webpDimensions(buffer = Buffer.alloc(0)) {
  if (buffer.subarray(0, 4).toString("latin1") !== "RIFF" || buffer.subarray(8, 12).toString("latin1") !== "WEBP") {
    return { width: null, height: null };
  }
  const chunk = buffer.subarray(12, 16).toString("latin1");
  if (chunk === "VP8X" && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && buffer.length >= 30) {
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && buffer.length >= 25) {
    const bits = buffer.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  return { width: null, height: null };
}

function svgDimensions(text = "") {
  const raw = String(text || "");
  const width = numberFromSvgLength(raw.match(/\bwidth=["']?([\d.]+)/i)?.[1]);
  const height = numberFromSvgLength(raw.match(/\bheight=["']?([\d.]+)/i)?.[1]);
  if (width && height) return { width, height };
  const viewBox = raw.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i);
  return {
    width: numberFromSvgLength(viewBox?.[1]) || null,
    height: numberFromSvgLength(viewBox?.[2]) || null,
  };
}

function wavProfile(buffer = Buffer.alloc(0)) {
  if (buffer.length < 44 || buffer.subarray(0, 4).toString("latin1") !== "RIFF" || buffer.subarray(8, 12).toString("latin1") !== "WAVE") {
    return {};
  }
  let offset = 12;
  let channels = null;
  let sampleRate = null;
  let byteRate = null;
  let dataBytes = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.subarray(offset, offset + 4).toString("latin1");
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "fmt " && dataStart + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(dataStart + 2);
      sampleRate = buffer.readUInt32LE(dataStart + 4);
      byteRate = buffer.readUInt32LE(dataStart + 8);
    }
    if (id === "data") dataBytes = size;
    offset = dataStart + size + (size % 2);
  }
  const durationSec = byteRate && dataBytes != null ? dataBytes / byteRate : null;
  return {
    channels,
    sampleRate,
    durationSec: durationSec != null ? Number(durationSec.toFixed(2)) : null,
    bitrateKbps: byteRate ? Math.round((byteRate * 8) / 1000) : null,
  };
}

function mediaNameTags(name = "", kind = "") {
  const lower = String(name || "").toLowerCase();
  const tags = [];
  if (/(hero|cover|banner|poster|主视觉|封面|海报)/i.test(lower)) tags.push("hero placement");
  if (/(logo|icon|brand|标志|图标|品牌)/i.test(lower)) tags.push("brand mark");
  if (/(loop|ambient|bg|background|背景|循环|氛围)/i.test(lower)) tags.push(kind === "audio" ? "ambient loop" : "background media");
  if (/(alert|notification|click|success|提示|成功|点击)/i.test(lower)) tags.push("feedback cue");
  return tags;
}

function mediaSummary(profile = {}) {
  const parts = [];
  if (profile.kind === "image") {
    parts.push(`Image ${profile.name || "asset"}`);
    if (profile.width && profile.height) parts.push(`${profile.width}x${profile.height}${profile.aspect ? ` ${profile.aspect}` : ""}`);
  } else if (profile.kind === "audio") {
    parts.push(`Audio ${profile.name || "asset"}`);
    if (profile.durationSec != null) parts.push(`${profile.durationSec}s`);
    if (profile.sampleRate) parts.push(`${profile.sampleRate}Hz`);
  } else if (profile.kind === "video") {
    parts.push(`Video ${profile.name || "asset"}`);
  } else if (profile.kind === "font") {
    parts.push(`Font ${profile.name || "asset"}`);
  }
  if (profile.tags?.length) parts.push(`tags: ${profile.tags.slice(0, 4).join(", ")}`);
  return parts.length ? parts.join("; ") : "";
}

function compactMediaProfile(profile = {}) {
  return {
    kind: profile.kind || "",
    format: profile.format || "",
    width: profile.width ?? null,
    height: profile.height ?? null,
    aspect: profile.aspect || "",
    durationSec: profile.durationSec ?? null,
    sampleRate: profile.sampleRate ?? null,
    channels: profile.channels ?? null,
    tags: Array.isArray(profile.tags) ? profile.tags.slice(0, 6) : [],
    summary: profile.summary || "",
  };
}

function aspectLabel(width, height) {
  if (!width || !height) return "";
  if (width === 480 && height === 360) return "480:360 fit";
  const ratio = width / height;
  if (Math.abs(ratio - 4 / 3) < 0.04) return "4:3";
  if (Math.abs(ratio - 16 / 9) < 0.05) return "16:9";
  if (Math.abs(ratio - 1) < 0.04) return "square";
  return `${ratio.toFixed(2)}:1`;
}

function numberFromSvgLength(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function mediaFormatFromMime(mime = "") {
  const parts = String(mime || "").split("/");
  return parts[1] || "";
}

function buildMediaPlan(byKind = {}, insights = {}, mediaProfiles = []) {
  const plan = [];
  if (byKind.image) plan.push("Use image assets as product hero, icon strip, texture, or compact slideshow with local paths.");
  if (byKind.video) plan.push("Use video assets as motion thumbnails, poster frames, timeline states, or very short local clips when contract-safe.");
  if (byKind.audio) plan.push("Expose audio assets as play/pause/status cues through the existing hardware audio APIs when relevant.");
  if (byKind.font) plan.push("Use font assets for typography direction while keeping fallback fonts readable on 480x360.");
  for (const profile of mediaProfiles.slice(0, 6)) {
    if (profile.kind === "image" && profile.width && profile.height) {
      plan.push(`Fit ${profile.name || "image asset"} (${profile.width}x${profile.height}) into the 480x360 screen without cropping important product content.`);
    }
    if (profile.kind === "audio" && profile.durationSec != null) {
      plan.push(`Represent ${profile.name || "audio asset"} as a ${profile.durationSec <= 6 ? "short sound cue" : "playback state"} with clear controls/status.`);
    }
  }
  if (insights.ctas?.length) plan.push(`Map CTA text into concise hardware-friendly controls: ${insights.ctas.slice(0, 4).join(", ")}.`);
  return uniqueStrings(plan);
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}
