import path from "node:path";
import { promises as fs } from "node:fs";
import {
  declaredAssetPathsFromManifest,
} from "./assetContract.mjs";

export function withAssetVersion(source, buildId) {
  const version = encodeURIComponent(buildId || Date.now());
  return String(source)
    .replace(/(["'])\.\/style\.css(?:\?[^"']*)?\1/g, `$1./style.css?v=${version}$1`)
    .replace(/(["'])\.\/app\.js(?:\?[^"']*)?\1/g, `$1./app.js?v=${version}$1`);
}

export function extractBuildSeedFromAppSource(appSource, fallback = {}) {
  const idMatch = String(appSource || "").match(/const BUILD_ID = ("(?:\\.|[^"\\])*");/);
  const promptMatch = String(appSource || "").match(/const PROMPT = ("(?:\\.|[^"\\])*");/);
  return {
    id: idMatch ? JSON.parse(idMatch[1]) : fallback.id,
    prompt: promptMatch ? JSON.parse(promptMatch[1]) : fallback.prompt
  };
}

export function buildCompileManifest({
  generatedManifest,
  previousManifest = {},
  pythonBin,
  hardwareCompileOutput = {},
  targetStatic,
  builtAt = new Date().toISOString()
}) {
  return {
    ...generatedManifest,
    ...previousManifest,
    compile: {
      web: "node --check app.js",
      hardware: `${pythonBin} -m py_compile hardware_app.py`,
      hardwareLog: hardwareCompileOutput.stderr || hardwareCompileOutput.stdout || "local py_compile ok"
    },
    target: targetStatic,
    builtAt
  };
}

export async function writeGeneratedFiles(dir, files) {
  await fs.mkdir(dir, { recursive: true });
  await fs.rm(path.join(dir, "assets"), { recursive: true, force: true }).catch(() => {});
  await Promise.all(Object.entries(files).map(([name, content]) => (
    writeGeneratedFile(dir, name, content)
  )));
}

export async function readGeneratedFiles(dir, generatedFileNames) {
  const files = {};
  for (const name of generatedFileNames) {
    try {
      files[name] = await fs.readFile(path.join(dir, name), "utf8");
    } catch {}
  }
  const manifest = parseManifest(files["manifest.json"]);
  for (const assetPath of declaredAssetPathsFromManifest(manifest)) {
    try {
      files[assetPath] = await fs.readFile(safeResolve(dir, assetPath));
    } catch {}
  }
  return files;
}

async function readManifest(dir) {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return {};
  }
}

export async function loadGeneratedWorkspace(dir, generatedFileNames, fallbackSeed = {
  id: "preview",
  prompt: "等待生成"
}) {
  const files = await readGeneratedFiles(dir, generatedFileNames);
  const manifest = await readManifest(dir);
  const seed = extractBuildSeedFromAppSource(files["app.js"], fallbackSeed);
  const id = manifest.id || seed.id;
  const prompt = manifest.prompt || seed.prompt;

  return {
    id,
    prompt,
    files,
    dir,
    built: Boolean(manifest.id),
    deployed: false,
    manifest,
    contractHash: String(manifest.contractHash || manifest.contract_hash || "").trim(),
  };
}

export async function ensureGeneratedWorkspace({
  dir,
  generatedFileNames,
  fallbackSeed,
  bootstrapFile = "",
  makeFiles
}) {
  await fs.mkdir(dir, { recursive: true });
  let seed = { ...fallbackSeed };
  let shouldBootstrap = false;
  if (bootstrapFile) {
    try {
      await fs.access(path.join(dir, bootstrapFile));
    } catch {
      shouldBootstrap = true;
    }
  }
  if (!shouldBootstrap) {
    try {
      const appSource = await fs.readFile(path.join(dir, "app.js"), "utf8");
      seed = extractBuildSeedFromAppSource(appSource, seed);
    } catch {}
  }

  const requiredFiles = makeFiles(seed);
  for (const name of generatedFileNames) {
    const filePath = path.join(dir, name);
    if (!shouldBootstrap) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > 0) continue;
      } catch {}
    }
    await fs.writeFile(filePath, requiredFiles[name] || "", "utf8");
  }

  return loadGeneratedWorkspace(dir, generatedFileNames, fallbackSeed);
}

async function writeGeneratedFile(dir, name, content) {
  const filePath = safeResolve(dir, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    await fs.writeFile(filePath, content);
    return;
  }
  await fs.writeFile(filePath, String(content ?? ""), "utf8");
}

function safeResolve(rootDir, fileName) {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, String(fileName).replace(/^[/\\]+/, ""));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to write outside generated workspace: ${fileName}`);
  }
  return target;
}

function parseManifest(raw) {
  try {
    return typeof raw === "string" && raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
