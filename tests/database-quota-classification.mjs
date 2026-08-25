import { classifyError } from "../src/errorClassifier.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const neonQuotaMessage = 'Server error (HTTP status 402): {"message":"Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.","code":"","detail":null,"hint":null,"neon:retryable":true}';

{
  const classified = classifyError(new Error(neonQuotaMessage));
  assert(classified.errorType === "database_quota", `expected database_quota, got ${JSON.stringify(classified)}`);
  assert(classified.statusCode === 503, `database quota should be surfaced as service unavailable, got ${classified.statusCode}`);
  assert(/database|Neon|data transfer|quota/i.test(classified.technicalDetail), `technical detail should preserve database evidence: ${classified.technicalDetail}`);
  assert(classified.nextActions.some(action => /database|Neon|plan|quota/i.test(action)), `next actions should mention database recovery: ${classified.nextActions.join(", ")}`);
}

{
  const classified = classifyError({
    type: "llm_failed",
    status: 402,
    message: neonQuotaMessage,
  });
  assert(classified.errorType === "database_quota", `database evidence should override explicit llm_failed, got ${JSON.stringify(classified)}`);
}

{
  const classified = classifyError(new Error("LLM_CALL_FAILED: HTTP 402; provider=insufficient balance"));
  assert(classified.errorType === "llm_quota", `provider quota should still be llm_quota, got ${JSON.stringify(classified)}`);
}

console.log("database quota classification ok");
