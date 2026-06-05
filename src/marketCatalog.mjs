import path from "node:path";
import { promises as fs } from "node:fs";

export const GENERATED_FILE_NAMES = ["index.html", "style.css", "app.js", "hardware_app.py", "manifest.json"];

export function normalizeCatalogApps(data, generatedFileNames = GENERATED_FILE_NAMES) {
  const apps = Array.isArray(data?.apps) ? data.apps : [];
  return apps.map(app => ({
    id: String(app.id || ""),
    conversation_id: app.conversation_id ?? null,
    name: app.name || app.title || "Untitled App",
    description: app.description || "",
    code: app.code || "",
    preview_url: app.preview_url ? `/${String(app.preview_url).replace(/^\/+/, "")}` : "",
    author: app.author || "community",
    downloads: Number(app.downloads || 0),
    created_at: app.created_at || "",
    source: app.source || "static",
    files: Array.isArray(app.files) ? app.files : generatedFileNames
  })).filter(app => app.id);
}

export function mergeMarketApps(dbApps, staticApps) {
  const dbIds = new Set(dbApps.map(app => app.id));
  return [
    ...dbApps,
    ...staticApps.filter(app => !dbIds.has(app.id))
  ];
}

export async function loadStaticMarketApps(marketRoot, generatedFileNames = GENERATED_FILE_NAMES) {
  try {
    const raw = await fs.readFile(path.join(marketRoot, "catalog.json"), "utf8");
    return normalizeCatalogApps(JSON.parse(raw), generatedFileNames);
  } catch {
    return [];
  }
}

export async function readStaticMarketCode(marketRoot, appId, generatedFileNames = GENERATED_FILE_NAMES) {
  const root = path.resolve(marketRoot);
  const appDir = path.resolve(root, String(appId || ""));
  if (appDir !== root && !appDir.startsWith(`${root}${path.sep}`)) return {};

  const codeFiles = {};
  for (const filename of generatedFileNames) {
    try {
      codeFiles[filename] = await fs.readFile(path.join(appDir, filename), "utf8");
    } catch {}
  }
  return codeFiles;
}
