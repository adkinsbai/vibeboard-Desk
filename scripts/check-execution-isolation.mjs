import { promises as fs } from "node:fs";

const checks = [
  {
    file: "src/generateRuntime.mjs",
    forbidden: [
      ["activeGenerate", "generation must not use a process-wide activeGenerate lock"],
      ["writeGeneratedFiles(generatedDir", "generation must write through a per-build workspace"],
    ],
  },
  {
    file: "src/buildRuntime.mjs",
    required: [
      ["buildCurrent({ build = null, context = null } = {})", "build verification must accept an explicit build handle"],
      ["assertBuildContext", "build verification must validate tenant/project ownership"],
    ],
  },
  {
    file: "src/jobRuntime.mjs",
    required: [
      ["maxConcurrency", "job runtime must expose bounded concurrent capacity"],
      ["claimJob", "job runtime must atomically claim queued work"],
    ],
  },
  {
    file: "server.mjs",
    required: [
      ["getRowsModified", "SQLite job claims must inspect the adapter's affected-row count"],
      ["build_id", "deploy requests must carry an explicit build identity"],
    ],
  },
];

for (const check of checks) {
  const source = await fs.readFile(check.file, "utf8");
  for (const [needle, message] of check.forbidden || []) {
    if (source.includes(needle)) throw new Error(`${check.file}: ${message}`);
  }
  for (const [needle, message] of check.required || []) {
    if (!source.includes(needle)) throw new Error(`${check.file}: ${message}`);
  }
}

console.log("execution isolation architecture checks ok");
