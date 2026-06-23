import path from "node:path";

export const ASSETS_DIR = "assets";
export const MAX_ASSET_COUNT = 64;
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_ASSET_BYTES = 8 * 1024 * 1024;
export const FILE_ENCODING_MARKER = "__vibeboardFileEncoding";

export const ALLOWED_ASSET_EXTENSIONS = Object.freeze([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".json",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".ttf",
  ".woff",
  ".woff2",
]);

export const ASSET_CONTRACT = Object.freeze({
  directory: ASSETS_DIR,
  declaration: "manifest.json assets[] or files[]",
  allowedExtensions: ALLOWED_ASSET_EXTENSIONS,
  maxAssetCount: MAX_ASSET_COUNT,
  maxAssetBytes: MAX_ASSET_BYTES,
  maxTotalAssetBytes: MAX_TOTAL_ASSET_BYTES,
});

const FORBIDDEN_ACTIVE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".sh",
  ".bat",
  ".cmd",
  ".ps1",
  ".py",
  ".php",
]);

const ASSET_REF_RE = /(?:url\(\s*|["'`(])(?:\.\/)?(assets\/[^"'`()\s?#]+)/gi;

export function normalizeAssetPath(value) {
  const raw = String(value || "").trim().replaceAll("\\", "/");
  if (!raw) throw new Error("asset path is empty");
  if (/^[a-zA-Z]:\//.test(raw) || raw.startsWith("/") || raw.startsWith("//")) {
    throw new Error("asset path must be relative");
  }

  const normalized = path.posix.normalize(raw.replace(/^\.\//, ""));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error("asset path must stay inside assets/");
  }
  if (!normalized.startsWith(`${ASSETS_DIR}/`)) {
    throw new Error("asset path must start with assets/");
  }
  if (normalized.endsWith("/") || normalized.split("/").some(part => !part || part === ".")) {
    throw new Error("asset path must point to a file");
  }
  if (/[\0\r\n]/.test(normalized)) {
    throw new Error("asset path contains invalid characters");
  }

  const ext = path.posix.extname(normalized).toLowerCase();
  if (FORBIDDEN_ACTIVE_EXTENSIONS.has(ext)) {
    throw new Error(`active asset extension is not allowed: ${ext}`);
  }
  if (!ALLOWED_ASSET_EXTENSIONS.includes(ext)) {
    throw new Error(`asset extension is not allowed: ${ext || "(none)"}`);
  }
  return normalized;
}

export function parseManifestFromFiles(files = {}) {
  const raw = files?.["manifest.json"];
  if (raw && typeof raw === "object" && !Buffer.isBuffer(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function normalizeManifestAssets(manifest = {}) {
  const issues = [];
  const candidates = [
    ...arrayOfStrings(manifest.assets),
    ...arrayOfStrings(manifest.files).filter(name => (
      String(name).replaceAll("\\", "/").replace(/^\.\//, "").startsWith(`${ASSETS_DIR}/`)
    )),
  ];
  const paths = [];
  const seen = new Set();

  for (const candidate of candidates) {
    try {
      const normalized = normalizeAssetPath(candidate);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        paths.push(normalized);
      }
    } catch (error) {
      issues.push(assetIssue("ASSET_PATH_INVALID", `manifest declares invalid asset path "${candidate}": ${error.message}`, {
        path: candidate,
      }));
    }
  }

  return { paths, issues };
}

export function declaredAssetPathsFromManifest(manifest = {}) {
  return normalizeManifestAssets(manifest).paths;
}

export function declaredAssetPathsFromFiles(files = {}) {
  return declaredAssetPathsFromManifest(parseManifestFromFiles(files));
}

export function assetPathsFromFiles(files = {}) {
  const paths = [];
  for (const name of Object.keys(files || {})) {
    try {
      paths.push(normalizeAssetPath(name));
    } catch {}
  }
  return [...new Set(paths)].sort();
}

export function extractAssetReferences(source = "") {
  const references = [];
  for (const match of String(source || "").matchAll(ASSET_REF_RE)) {
    try {
      references.push(normalizeAssetPath(match[1]));
    } catch {}
  }
  return [...new Set(references)].sort();
}

export function validateAssetContracts(files = {}, {
  label = "Generated app",
  generatedFileNames = [],
  extraAllowedFileNames = [],
} = {}) {
  const issues = [];
  const generatedNames = new Set([...generatedFileNames, ...extraAllowedFileNames]);
  const declared = normalizeManifestAssets(parseManifestFromFiles(files));
  issues.push(...declared.issues);

  const declaredSet = new Set(declared.paths);
  const actualAssets = [];
  let totalBytes = 0;

  for (const [name, content] of Object.entries(files || {})) {
    if (generatedNames.has(name)) continue;

    let normalized = "";
    try {
      normalized = normalizeAssetPath(name);
    } catch (error) {
      issues.push(assetIssue("UNSUPPORTED_FILE", `${label} contains unsupported file "${name}". ${error.message}`, {
        fileName: name,
      }));
      continue;
    }

    actualAssets.push(normalized);
    if (!declaredSet.has(normalized)) {
      issues.push(assetIssue("ASSET_UNDECLARED", `${label} asset ${normalized} must be declared in manifest.json assets[].`, {
        fileName: normalized,
      }));
    }

    const size = byteLength(content);
    totalBytes += size;
    if (size > MAX_ASSET_BYTES) {
      issues.push(assetIssue("ASSET_TOO_LARGE", `${label} asset ${normalized} is larger than ${MAX_ASSET_BYTES} bytes.`, {
        fileName: normalized,
        size,
        limit: MAX_ASSET_BYTES,
      }));
    }
  }

  for (const declaredPath of declared.paths) {
    if (!Object.prototype.hasOwnProperty.call(files, declaredPath)) {
      issues.push(assetIssue("ASSET_MISSING", `${label} declares ${declaredPath} but the file is missing.`, {
        fileName: declaredPath,
      }));
    }
  }

  if (actualAssets.length > MAX_ASSET_COUNT) {
    issues.push(assetIssue("ASSET_COUNT_TOO_LARGE", `${label} has ${actualAssets.length} assets; limit is ${MAX_ASSET_COUNT}.`, {
      count: actualAssets.length,
      limit: MAX_ASSET_COUNT,
    }));
  }
  if (totalBytes > MAX_TOTAL_ASSET_BYTES) {
    issues.push(assetIssue("ASSET_TOTAL_TOO_LARGE", `${label} assets total ${totalBytes} bytes; limit is ${MAX_TOTAL_ASSET_BYTES}.`, {
      size: totalBytes,
      limit: MAX_TOTAL_ASSET_BYTES,
    }));
  }

  const referenced = new Set([
    ...extractAssetReferences(files["index.html"]),
    ...extractAssetReferences(files["style.css"]),
    ...extractAssetReferences(files["app.js"]),
  ]);
  for (const ref of referenced) {
    if (!declaredSet.has(ref)) {
      issues.push(assetIssue("ASSET_REFERENCE_UNDECLARED", `${label} references ${ref} but does not declare it in manifest.json assets[].`, {
        fileName: ref,
      }));
    }
  }

  return issues;
}

export function filterDeployableFiles(files = {}, generatedFileNames = []) {
  const allowedGenerated = new Set(generatedFileNames);
  const declaredAssets = new Set(declaredAssetPathsFromFiles(files));
  const output = {};
  for (const [name, content] of Object.entries(files || {})) {
    if (allowedGenerated.has(name) || declaredAssets.has(name)) {
      output[name] = content;
    }
  }
  return output;
}

export function serializeFileMap(files = {}) {
  const output = {};
  for (const [name, value] of Object.entries(files || {})) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      output[name] = {
        [FILE_ENCODING_MARKER]: "base64",
        data: Buffer.from(value).toString("base64"),
        byteLength: Buffer.byteLength(value),
      };
    } else {
      output[name] = value;
    }
  }
  return output;
}

export function deserializeFileMap(files = {}) {
  const output = {};
  for (const [name, value] of Object.entries(files || {})) {
    if (value && typeof value === "object" && value[FILE_ENCODING_MARKER] === "base64") {
      output[name] = Buffer.from(String(value.data || ""), "base64");
    } else if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
      output[name] = Buffer.from(value.data);
    } else {
      output[name] = value;
    }
  }
  return output;
}

function assetIssue(code, message, evidence = {}) {
  return {
    code,
    message,
    phase: "contract",
    evidence,
  };
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || "").trim()).filter(Boolean);
}

function byteLength(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.byteLength(value);
  return Buffer.byteLength(String(value ?? ""), "utf8");
}
