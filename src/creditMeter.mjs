export const TOKENS_PER_CREDIT = 10000;
export const RMB_PER_100K_TOKENS = 10;

export function estimateTokensFromMessages(messages = []) {
  const chars = Array.isArray(messages)
    ? messages.reduce((sum, message) => sum + String(message?.content || "").length, 0)
    : String(messages || "").length;
  return Math.max(1, Math.ceil(chars / 4));
}

export function estimateTokensFromPayload(payload = {}) {
  if (payload?.usage?.total_tokens) return Number(payload.usage.total_tokens) || 0;
  const messages = payload?.messages || [];
  const maxTokens = Number(payload?.max_tokens || payload?.max_completion_tokens || 0);
  return estimateTokensFromMessages(messages) + Math.min(Math.max(maxTokens, 0), 2000);
}

export function tokensFromModelResponse(data = {}, fallbackTokens = 0) {
  const usage = data?.usage || {};
  const total = Number(usage.total_tokens || 0);
  if (total > 0) return total;
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  if (prompt + completion > 0) return prompt + completion;
  return Math.max(1, Number(fallbackTokens || 0));
}

export function creditsForTokens(tokens) {
  return roundCredits(Number(tokens || 0) / TOKENS_PER_CREDIT);
}

export function roundCredits(value) {
  return Math.ceil(Number(value || 0) * 10000) / 10000;
}

export async function meterAiCall({
  authStore,
  user,
  reason = "ai_call",
  metadata = {},
  estimateTokens = 0,
  call,
} = {}) {
  if (typeof call !== "function") throw new Error("metered call is required");
  const result = await call();
  if (!authStore || !user?.id) return result;
  const tokens = Math.max(1, Number(result?.usage?.total_tokens || result?.tokens || estimateTokens || 0));
  const credits = creditsForTokens(tokens);
  await authStore.applyCreditDelta({
    userId: user.id,
    delta: -credits,
    reason,
    tokens,
    metadata: {
      ...metadata,
      tokens_per_credit: TOKENS_PER_CREDIT,
      rmb_per_100k_tokens: RMB_PER_100K_TOKENS,
      estimated: !result?.usage?.total_tokens,
    },
  });
  return result;
}
