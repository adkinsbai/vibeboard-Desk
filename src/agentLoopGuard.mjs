import { createHash } from "node:crypto";

export function createAgentLoopGuard({ maxSameActionWithoutProgress = 2 } = {}) {
  const counts = new Map();

  return {
    beforeTool({ name = "", args = {}, fileRevision = 0 } = {}) {
      if (name === "done") return { allowed: true, code: "", guidance: "" };
      const key = fingerprint(name, args, fileRevision);
      const count = (counts.get(key) || 0) + 1;
      counts.set(key, count);
      if (count <= maxSameActionWithoutProgress) {
        return { allowed: true, code: "", guidance: "" };
      }
      return {
        allowed: false,
        code: "duplicate_action_without_progress",
        guidance: "Choose a different action that changes files or gathers new evidence before retrying this tool.",
      };
    },
  };
}

function fingerprint(name, args, fileRevision) {
  const input = `${name}\n${stableJson(args)}\n${Number(fileRevision) || 0}`;
  return createHash("sha256").update(input).digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
