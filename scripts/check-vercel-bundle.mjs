import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vercelConfig = JSON.parse(readFileSync(path.join(repoRoot, "vercel.json"), "utf8"));
const includeFiles = String(vercelConfig.functions?.["server.mjs"]?.includeFiles || "");

const htmlEntrypoints = ["index.html", "portal.html", "admin.html", "market.html"];
const requiredFiles = new Set(htmlEntrypoints);

for (const htmlFile of htmlEntrypoints) {
  const html = readFileSync(path.join(repoRoot, htmlFile), "utf8");
  const scriptPattern = /<script\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const src = String(match[1] || "").trim();
    if (!src || /^https?:\/\//i.test(src) || src.startsWith("//")) continue;
    requiredFiles.add(src.replace(/^\.\//, "").split(/[?#]/)[0]);
  }
}

const missing = [...requiredFiles]
  .filter(Boolean)
  .filter(file => !isIncluded(file));

if (missing.length) {
  console.error(`vercel includeFiles is missing browser entry assets: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`vercel bundle check passed (${requiredFiles.size} entry assets)`);

function isIncluded(file) {
  if (includeFiles.includes(file)) return true;
  if (/\.html$/i.test(file) && includeFiles.includes("*.html")) return true;
  if (/\.js$/i.test(file) && includeFiles.includes("*.js")) return true;
  if (/\.css$/i.test(file) && includeFiles.includes("*.css")) return true;
  return false;
}
