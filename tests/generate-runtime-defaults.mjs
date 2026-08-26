import { buildGenerateAgentSettings } from "../src/generateRuntime.mjs";
import { assert } from "./support/serverHarness.mjs";

const settings = buildGenerateAgentSettings({}, {}, undefined, {
  maxIterations: 12,
  timeoutMs: 300000,
});

assert(settings.maxIterations === 12, "partial runtime defaults should retain explicit overrides");
assert(settings.timeoutMs === 300000, "partial runtime defaults should retain timeout overrides");
assert(settings.maxVerificationAttempts === 1, "partial runtime defaults should inherit verification attempts");
assert(settings.repairAttempts === 2, "partial runtime defaults should inherit automatic repair attempts");
assert(settings.llmTimeoutMs === 60000, "partial runtime defaults should inherit the model timeout");

console.log("generate runtime partial defaults merge ok");
