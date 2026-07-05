import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeProjectMemory } from "./conversationStore.mjs";

const DEFAULT_PROJECTS_DIR = "VibeBoard Projects";

export function createProjectWorkspace({
  root,
  env = process.env,
  conversationStore,
  assetLibraryStore,
  now = () => new Date(),
} = {}) {
  if (!root) throw new Error("project workspace root is required");
  if (!conversationStore) throw new Error("conversationStore is required");
  const defaultBaseDir = env.VERCEL === "1"
    ? path.join(os.tmpdir(), DEFAULT_PROJECTS_DIR)
    : path.join(root, DEFAULT_PROJECTS_DIR);
  const baseDir = path.resolve(env.VIBEBOARD_PROJECTS_DIR || defaultBaseDir);

  async function ensureBaseDir() {
    await fs.mkdir(baseDir, { recursive: true });
  }

  async function ensureProject(conversationId, title = "New Project") {
    await ensureBaseDir();
    const existing = await conversationStore.getConversation?.(conversationId);
    if (existing?.project_dir) {
      await fs.mkdir(existing.project_dir, { recursive: true });
      await ensureProjectSubdirs(existing.project_dir);
      return { id: conversationId, title: existing.title || title, project_dir: existing.project_dir };
    }
    const projectDir = await uniqueProjectDir(title, conversationId);
    await fs.mkdir(projectDir, { recursive: true });
    await ensureProjectSubdirs(projectDir);
    await writeProjectReadme(projectDir, title, conversationId);
    const updated = await conversationStore.updateConversation?.(conversationId, { projectDir });
    return { id: conversationId, title: updated?.title || title, project_dir: projectDir };
  }

  async function createProject({ id = "", title = "New Project" } = {}) {
    const conversationId = id || "";
    const projectDir = await uniqueProjectDir(title, conversationId);
    await fs.mkdir(projectDir, { recursive: true });
    await ensureProjectSubdirs(projectDir);
    await writeProjectReadme(projectDir, title, conversationId);
    return { project_dir: projectDir };
  }

  async function writeMemory(conversationId, { trigger = "manual", buildId = "", prompt = "", deploy = null } = {}) {
    const conversation = await conversationStore.getConversation?.(conversationId);
    if (!conversation) return null;
    const project = await ensureProject(conversationId, conversation.title || "New Project");
    const memory = normalizeProjectMemory(await conversationStore.getProjectMemory(conversationId));
    const messages = (await conversationStore.listMessages(conversationId)).slice(-20);
    const assets = assetLibraryStore?.listAssets ? assetLibraryStore.listAssets(conversationId) : [];
    const lines = [
      `# ${conversation.title || "VibeBoard Project"} Memory`,
      "",
      `Project ID: ${conversationId}`,
      `Project folder: ${project.project_dir}`,
      `Updated: ${dateIso(now())}`,
      `Trigger: ${trigger}`,
      buildId ? `Build: ${buildId}` : "",
      prompt ? `Prompt: ${prompt}` : "",
      "",
      "## Current Project Memory",
      memory.summary ? `Summary: ${memory.summary}` : "Summary: ",
      memory.goal ? `Goal: ${memory.goal}` : "Goal: ",
      sectionList("Requirements", memory.requirements),
      sectionList("Constraints", memory.constraints),
      sectionList("Decisions", memory.decisions),
      sectionList("Open Questions", memory.open_questions),
      memory.build_prompt ? `Build prompt: ${memory.build_prompt}` : "",
      "",
      "## Recent Conversation",
      ...messages.map(msg => `- ${msg.role}: ${String(msg.content || "").replace(/\s+/g, " ").slice(0, 500)}`),
      "",
      "## Assets",
      ...assets.map(asset => `- ${asset.name} [${asset.kind}] ${asset.size} bytes usage=${asset.usage || inferredUsage(asset)}`),
      "",
      "## Deploy",
      deploy ? JSON.stringify(deploy, null, 2) : "No deploy record in this memory write.",
      "",
    ].filter(line => line !== "");
    const memoryPath = path.join(project.project_dir, "MEMORY.md");
    await fs.writeFile(memoryPath, lines.join("\n"), "utf8");
    return { path: memoryPath, project_dir: project.project_dir };
  }

  async function persistAssetFile(conversationId, asset = {}) {
    const conversation = await conversationStore.getConversation?.(conversationId);
    if (!conversation) return null;
    const project = await ensureProject(conversationId, conversation.title || "New Project");
    const assetDir = path.join(project.project_dir, "assets", asset.kind || "misc");
    await fs.mkdir(assetDir, { recursive: true });
    const filename = safeFileName(asset.name || asset.id || "asset");
    const target = path.join(assetDir, filename);
    const content = decodeAssetContent(asset);
    await fs.writeFile(target, content);
    return relativeProjectPath(project.project_dir, target);
  }

  async function writeBuildSnapshot(conversationId, buildId, files = {}, assets = []) {
    if (!conversationId || !buildId) return null;
    const conversation = await conversationStore.getConversation?.(conversationId);
    if (!conversation) return null;
    const project = await ensureProject(conversationId, conversation.title || "New Project");
    const buildDir = path.join(project.project_dir, "builds", safeFileName(buildId));
    await fs.mkdir(buildDir, { recursive: true });
    for (const [name, content] of Object.entries(files || {})) {
      const target = safeJoin(buildDir, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (Buffer.isBuffer(content)) {
        await fs.writeFile(target, content);
      } else {
        await fs.writeFile(target, String(content || ""), "utf8");
      }
    }
    await fs.writeFile(path.join(buildDir, "asset-snapshot.json"), JSON.stringify({
      build_id: buildId,
      created_at: dateIso(now()),
      assets: assets.map(asset => ({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        path: asset.path || asset.project_path || "",
        usage: asset.usage || inferredUsage(asset),
        sha256: asset.sha256 || "",
      })),
    }, null, 2), "utf8");
    return { path: buildDir, relative: relativeProjectPath(project.project_dir, buildDir) };
  }

  async function listProjectFiles(conversationId) {
    const conversation = await conversationStore.getConversation?.(conversationId);
    if (!conversation?.project_dir) return [];
    return listFiles(conversation.project_dir, conversation.project_dir);
  }

  async function readProjectFile(conversationId, relativePath) {
    const conversation = await conversationStore.getConversation?.(conversationId);
    if (!conversation?.project_dir) return null;
    const target = safeJoin(conversation.project_dir, relativePath);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat?.isFile()) return null;
    const buffer = await fs.readFile(target);
    return {
      path: relativeProjectPath(conversation.project_dir, target),
      size: buffer.byteLength,
      encoding: isLikelyText(buffer) ? "utf8" : "base64",
      content: isLikelyText(buffer) ? buffer.toString("utf8") : buffer.toString("base64"),
      updated_at: stat.mtime ? stat.mtime.toISOString() : "",
    };
  }

  async function renameAssetFile(conversationId, currentProjectPath, nextName) {
    const conversation = await conversationStore.getConversation?.(conversationId);
    if (!conversation?.project_dir || !currentProjectPath) return "";
    const current = safeJoin(conversation.project_dir, currentProjectPath);
    const stat = await fs.stat(current).catch(() => null);
    if (!stat?.isFile()) return "";
    const next = path.join(path.dirname(current), safeFileName(nextName || path.basename(current)));
    await fs.rename(current, next);
    return relativeProjectPath(conversation.project_dir, next);
  }

  async function uniqueProjectDir(title, id = "") {
    await ensureBaseDir();
    const baseName = safeFileName(title || "New Project").slice(0, 80) || "New Project";
    const suffix = id ? `-${String(id).slice(0, 8)}` : "";
    let candidate = path.join(baseDir, `${baseName}${suffix}`);
    let index = 2;
    while (await exists(candidate)) {
      candidate = path.join(baseDir, `${baseName}-${index}${suffix}`);
      index += 1;
    }
    return candidate;
  }

  return {
    baseDir,
    ensureBaseDir,
    createProject,
    ensureProject,
    writeMemory,
    persistAssetFile,
    writeBuildSnapshot,
    listProjectFiles,
    readProjectFile,
    renameAssetFile,
  };
}

async function ensureProjectSubdirs(projectDir) {
  await Promise.all([
    fs.mkdir(path.join(projectDir, "assets"), { recursive: true }),
    fs.mkdir(path.join(projectDir, "builds"), { recursive: true }),
    fs.mkdir(path.join(projectDir, "notes"), { recursive: true }),
  ]);
}

async function writeProjectReadme(projectDir, title, id) {
  const file = path.join(projectDir, "README.md");
  if (await exists(file)) return;
  await fs.writeFile(file, [
    `# ${title || "VibeBoard Project"}`,
    "",
    `Project ID: ${id || ""}`,
    "",
    "This folder is managed by VibeBoard. Assets, generated build snapshots, and MEMORY.md live here.",
    "",
  ].join("\n"), "utf8");
}

function sectionList(title, items = []) {
  if (!Array.isArray(items) || !items.length) return `${title}:`;
  return [`${title}:`, ...items.map(item => `- ${item}`)].join("\n");
}

function inferredUsage(asset = {}) {
  if (asset.usage) return asset.usage;
  if (["image", "video", "audio", "font", "text", "data"].includes(asset.kind)) return "embeddable";
  return "reference_only";
}

function decodeAssetContent(asset = {}) {
  if (Buffer.isBuffer(asset.content)) return asset.content;
  if (asset.encoding === "base64") return Buffer.from(String(asset.content || ""), "base64");
  return Buffer.from(String(asset.content || ""), "utf8");
}

function safeFileName(value) {
  const leaf = String(value || "file")
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .pop() || "file";
  return leaf
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "file";
}

function safeJoin(root, name) {
  const target = path.resolve(root, String(name || "").replaceAll("\\", "/"));
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`unsafe project path: ${name}`);
  }
  return target;
}

async function listFiles(root, dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, full));
    } else if (entry.isFile()) {
      const stat = await fs.stat(full).catch(() => null);
      files.push({
        path: relativeProjectPath(root, full),
        size: stat?.size || 0,
        updated_at: stat?.mtime ? stat.mtime.toISOString() : "",
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function relativeProjectPath(root, target) {
  return path.relative(root, target).replaceAll("\\", "/");
}

function isLikelyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.byteLength, 4096));
  if (!sample.length) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.05;
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false);
}

function dateIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
