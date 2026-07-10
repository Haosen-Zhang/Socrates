import type { AppConfig } from "@socrates/core";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 按配置决定出站代理：
 * - off    直连（不设代理）
 * - custom 用用户填的地址
 * - auto   沿用环境变量里的代理（HTTPS_PROXY / HTTP_PROXY）
 */
export function resolveProxy(cfg: AppConfig): string | undefined {
  if (cfg.proxy.mode === "custom") return cfg.proxy.url.trim() || undefined;
  if (cfg.proxy.mode === "auto") {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      undefined
    );
  }
  return undefined; // off
}

/** 返回一个每次调用都按当前配置套用代理的 fetch（Bun fetch 支持 proxy 选项）。 */
export function makeProxiedFetch(getConfig: () => AppConfig): FetchLike {
  return (url, init) => {
    const proxy = resolveProxy(getConfig());
    return fetch(url, { ...init, ...(proxy ? { proxy } : {}) } as RequestInit);
  };
}
