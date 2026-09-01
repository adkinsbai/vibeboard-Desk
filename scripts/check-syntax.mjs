import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const explicitFiles = [
  "server.mjs",
  "app.js",
  "admin.js",
];

const sourceDirs = ["src", "tests"];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (!entry.isFile()) return [];
    if (!/\.(mjs|js)$/.test(entry.name)) return [];
    return [fullPath];
  });
}

const files = [
  ...explicitFiles.map((file) => path.join(repoRoot, file)).filter(existsSync),
  ...sourceDirs.flatMap((dir) => walk(path.join(repoRoot, dir))),
];

const uniqueFiles = [...new Set(files)].sort();
let failed = false;

for (const file of uniqueFiles) {
  const relative = path.relative(repoRoot, file);
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.status === 0) {
    console.log(`ok ${relative}`);
    continue;
  }

  failed = true;
  console.error(`not ok ${relative}`);
  if (result.stdout) console.error(result.stdout.trim());
  if (result.stderr) console.error(result.stderr.trim());
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log(`syntax check passed (${uniqueFiles.length} files)`);
}
