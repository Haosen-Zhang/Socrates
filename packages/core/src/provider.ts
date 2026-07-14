export type ProviderType = "openai_compatible" | "anthropic";

export type Provider = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  defaultModel?: string;
  /** Keychain 条目引用，明文 key 永不出现在存储与传输中 */
  apiKeyRef: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  openai_compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

export type ProviderInput = {
  name: string;
  type: ProviderType;
  baseUrl?: string;
  defaultModel?: string;
};

export function validateProviderInput(input: ProviderInput): string | null {
  if (!input.name.trim()) return "name 不能为空";
  if (!(input.type in DEFAULT_BASE_URLS)) return `未知 provider 类型: ${input.type}`;
  if (input.baseUrl !== undefined && input.baseUrl !== "" && !/^https?:\/\//.test(input.baseUrl)) {
    return "baseUrl 必须是 http(s) URL";
  }
  return null;
}

export function resolveBaseUrl(type: ProviderType, baseUrl?: string): string {
  const url = baseUrl?.trim() || DEFAULT_BASE_URLS[type];
  return url.replace(/\/+$/, "");
}

export type TestRequest = { url: string; headers: Record<string, string> };

/** 连接测试用「列模型」端点：无副作用、不消耗 token、能区分鉴权错误 */
export function buildTestRequest(type: ProviderType, baseUrl: string, apiKey: string): TestRequest {
  if (type === "anthropic") {
    return {
      url: `${baseUrl}/v1/models`,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  return {
    url: `${baseUrl}/models`,
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

export type TestOutcome = "ok" | "auth_failed" | "network_error" | "error";

/** status undefined 表示 fetch 本身失败（DNS/超时/拒连） */
export function classifyTestOutcome(status?: number): TestOutcome {
  if (status === undefined) return "network_error";
  if (status === 401 || status === 403) return "auth_failed";
  if (status >= 200 && status < 300) return "ok";
  return "error";
}

const LOW_COST_OPENAI_ALIASES = [
  "gpt-5-nano",
  "gpt-4o-mini",
  "gpt-5.4-nano",
  "gpt-5-mini",
  "gpt-5.4-mini",
  "gpt-5.6-luna",
] as const;

const NON_CHAT_MODEL =
  /(?:embedding|moderation|audio|realtime|transcri|tts|whisper|image|dall-e|search|computer-use|sora)/i;

function openAiCostRank(model: string): number {
  const known = LOW_COST_OPENAI_ALIASES.indexOf(model as (typeof LOW_COST_OPENAI_ALIASES)[number]);
  if (known >= 0) return known;
  if (/(?:^|[-_.])nano(?:$|[-_.])/i.test(model)) return 20;
  if (/(?:^|[-_.])mini(?:$|[-_.])/i.test(model)) return 30;
  if (/(?:^|[-_.])luna(?:$|[-_.])/i.test(model)) return 35;
  if (/(?:^|[-_.])terra(?:$|[-_.])/i.test(model)) return 50;
  if (/(?:^|[-_.])(?:sol|pro)(?:$|[-_.])/i.test(model)) return 80;
  return 60;
}

/**
 * Pick a low-cost text/chat alias from the models returned by OpenAI.
 * Known aliases follow current published token prices; tier-name scoring keeps
 * the fallback useful when OpenAI adds a new family before Socrates updates.
 */
export function selectCheapestOpenAiModel(models: string[]): string | undefined {
  return models
    .filter((model) => /^(?:gpt-|chatgpt-|o\d)/i.test(model) && !NON_CHAT_MODEL.test(model))
    .sort((a, b) => openAiCostRank(a) - openAiCostRank(b) || a.length - b.length || a.localeCompare(b))[0];
}
