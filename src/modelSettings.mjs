export const MODEL_PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash"
  },
  minimax: {
    label: "MiniMax",
    baseUrl: "https://api.minimaxi.com/v1",
    model: "MiniMax-M2.7"
  },
  custom: {
    label: "Custom",
    baseUrl: "",
    model: ""
  }
};

export function normalizeModelSettings(input = {}) {
  const providerId = String(input.provider || "deepseek").toLowerCase();
  const preset = MODEL_PROVIDERS[providerId] || MODEL_PROVIDERS.custom;
  const baseUrl = String(input.baseUrl || preset.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(input.model || preset.model || "").trim();
  const apiKey = String(input.apiKey || "").trim();
  return {
    provider: providerId,
    providerLabel: preset.label || providerId,
    baseUrl,
    model,
    apiKey,
    enabled: Boolean(apiKey && baseUrl && model)
  };
}

export function chatCompletionsUrl(baseUrl) {
  return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
}
