import { buildProxyUrl, isHostBypassed, type AppConfig } from "@socrates/core";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type ProxyEnvironment = Record<string, string | undefined>;

export type ProxyResolutionDependencies = {
  env?: ProxyEnvironment;
  platform?: string;
  readMacSystemProxy?: () => string | undefined;
};

const MAC_PROXY_CACHE_MS = 5_000;
let macProxyCache: { expiresAt: number; output: string | undefined } | undefined;

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function formatProxyUrl(scheme: "http" | "socks5", host: string | undefined, port: string | undefined) {
  const trimmedHost = host?.trim();
  const numericPort = Number(port);
  if (!trimmedHost || /\s/.test(trimmedHost) || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    return undefined;
  }
  const urlHost = trimmedHost.includes(":") && !trimmedHost.startsWith("[") ? `[${trimmedHost}]` : trimmedHost;
  return `${scheme}://${urlHost}:${numericPort}`;
}

/** Parse the stable key/value portion of `scutil --proxy` output. */
export function parseMacSystemProxy(output: string, targetUrl: string): string | undefined {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (match) values.set(match[1], match[2]);
  }

  let targetProtocol = "https:";
  try {
    targetProtocol = new URL(targetUrl).protocol;
  } catch {
    // Keep HTTPS-first behavior for malformed URLs and let fetch report the URL error.
  }

  const protocols = targetProtocol === "http:" ? ["HTTP", "HTTPS", "SOCKS"] : ["HTTPS", "HTTP", "SOCKS"];
  for (const protocol of protocols) {
    if (!enabled(values.get(`${protocol}Enable`))) continue;
    const proxy = formatProxyUrl(
      protocol === "SOCKS" ? "socks5" : "http",
      values.get(`${protocol}Proxy`),
      values.get(`${protocol}Port`),
    );
    if (proxy) return proxy;
  }
  return undefined;
}

/** Read macOS' current manual proxy settings. Fail closed to direct mode. */
export function readMacSystemProxy(): string | undefined {
  const now = Date.now();
  if (macProxyCache && macProxyCache.expiresAt > now) return macProxyCache.output;

  let output: string | undefined;
  try {
    const result = Bun.spawnSync(["/usr/sbin/scutil", "--proxy"]);
    if (result.exitCode === 0) output = new TextDecoder().decode(result.stdout);
  } catch {
    // `scutil` is macOS-only and proxy discovery must never prevent startup.
  }
  macProxyCache = { expiresAt: now + MAC_PROXY_CACHE_MS, output };
  return output;
}

/**
 * 按配置为某个目标 URL 决定代理：
 * - off    直连
 * - auto   优先沿用环境变量；macOS 下回退到系统代理
 * - custom 用 url 覆盖或 type/host/port 拼出的地址
 * 命中 noProxy 列表的主机一律直连。
 */
export function resolveProxyFor(
  cfg: AppConfig,
  targetUrl: string,
  dependencies: ProxyResolutionDependencies = {},
): string | undefined {
  if (cfg.proxy.mode === "off") return undefined;
  let hostname = "";
  try {
    hostname = new URL(targetUrl).hostname;
  } catch {
    // 非法 URL 交给 fetch 自己报错
  }
  if (hostname && isHostBypassed(cfg.proxy.noProxy, hostname)) return undefined;
  if (cfg.proxy.mode === "auto") {
    const env = dependencies.env ?? process.env;
    const environmentProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || undefined;
    if (environmentProxy) return environmentProxy;

    const platform = dependencies.platform ?? process.platform;
    if (platform === "darwin") {
      const output = (dependencies.readMacSystemProxy ?? readMacSystemProxy)();
      if (output) return parseMacSystemProxy(output, targetUrl);
    }
    return undefined;
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
