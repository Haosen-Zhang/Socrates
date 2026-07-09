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
