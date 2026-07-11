import { buildProxyUrl, isHostBypassed, type AppConfig } from "@socrates/core";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * 按配置为某个目标 URL 决定代理：
 * - off    直连
 * - auto   沿用环境变量（HTTPS_PROXY / HTTP_PROXY）
 * - custom 用 url 覆盖或 type/host/port 拼出的地址
 * 命中 noProxy 列表的主机一律直连。
 */
export function resolveProxyFor(cfg: AppConfig, targetUrl: string): string | undefined {
  if (cfg.proxy.mode === "off") return undefined;
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    // 非法 URL 交给 fetch 自己报错
  }
  if (hostname && isHostBypassed(cfg.proxy.noProxy, hostname)) return undefined;
  if (cfg.proxy.mode === "auto") {
    return (
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      undefined
    );
  }
  return buildProxyUrl(cfg.proxy);
}

/** 返回一个每次调用都按当前配置套用代理的 fetch（Bun fetch 支持 proxy 选项）。 */
export function makeProxiedFetch(getConfig: () => AppConfig): FetchLike {
  return (url, init) => {
    const proxy = resolveProxyFor(getConfig(), url);
    return fetch(url, { ...init, ...(proxy ? { proxy } : {}) } as RequestInit);
  };
}
