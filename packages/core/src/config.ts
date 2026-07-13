/** 应用配置（config.toml 的形状）。只放非敏感项——API Key 仍在 Keychain（NFR-001）。 */
export type ProxyMode = "off" | "auto" | "custom";
export type ProxyType = "http" | "https" | "socks5" | "socks5h";

export type ProxyConfig = {
  mode: ProxyMode;
  type: ProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
  /** 填写后覆盖 host/port/type 拼出的地址 */
  url: string;
  /** 逗号分隔的直连主机（如 localhost,127.0.0.1,.local） */
  noProxy: string;
};

export type AppConfig = {
  language: "zh-CN" | "zh-TW" | "en";
  theme: "light" | "dark";
  /** 关闭窗口时：后台驻留 / 直接退出 */
  closeBehavior: "background" | "quit";
  /** 8-bit 界面音效 */
  soundEnabled: boolean;
  proxy: ProxyConfig;
  appearance: { fontSize: number; fontFamily: string };
};

export const DEFAULT_CONFIG: AppConfig = {
  language: "zh-CN",
  theme: "light",
  closeBehavior: "background",
  soundEnabled: true,
  proxy: {
    mode: "off",
    type: "http",
    host: "",
    port: "",
    username: "",
    password: "",
    url: "",
    noProxy: "localhost,127.0.0.1,.local",
  },
  appearance: { fontSize: 14, fontFamily: "system" },
};

const LANGS = ["zh-CN", "zh-TW", "en"] as const;
const THEMES = ["light", "dark"] as const;
const CLOSE = ["background", "quit"] as const;
const PROXY = ["off", "auto", "custom"] as const;
const PROXY_TYPE = ["http", "https", "socks5", "socks5h"] as const;
const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

function pick<T extends readonly string[]>(vals: T, v: unknown, fallback: T[number]): T[number] {
  return typeof v === "string" && (vals as readonly string[]).includes(v) ? (v as T[number]) : fallback;
}

/** 把（可能被用户手工编辑过的）解析结果规整成合法配置，缺失/非法字段回退默认。 */
export function normalizeConfig(raw: unknown): AppConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const proxy = (r.proxy ?? {}) as Record<string, unknown>;
  const appearance = (r.appearance ?? {}) as Record<string, unknown>;
  const size = Number(appearance.fontSize);
  return {
    language: pick(LANGS, r.language, DEFAULT_CONFIG.language),
    theme: pick(THEMES, r.theme, DEFAULT_CONFIG.theme),
    closeBehavior: pick(CLOSE, r.closeBehavior, DEFAULT_CONFIG.closeBehavior),
    soundEnabled: typeof r.soundEnabled === "boolean" ? r.soundEnabled : DEFAULT_CONFIG.soundEnabled,
    proxy: {
      mode: pick(PROXY, proxy.mode, DEFAULT_CONFIG.proxy.mode),
      type: pick(PROXY_TYPE, proxy.type, DEFAULT_CONFIG.proxy.type),
      host: str(proxy.host, ""),
      port: proxy.port == null ? "" : String(proxy.port),
      username: str(proxy.username, ""),
      password: str(proxy.password, ""),
      url: str(proxy.url, ""),
      noProxy: str(proxy.noProxy, DEFAULT_CONFIG.proxy.noProxy),
    },
    appearance: {
      fontSize: Number.isFinite(size) && size >= 10 && size <= 24 ? size : DEFAULT_CONFIG.appearance.fontSize,
      fontFamily: typeof appearance.fontFamily === "string" ? appearance.fontFamily : DEFAULT_CONFIG.appearance.fontFamily,
    },
  };
}

/** custom 模式下拼出代理 URL：url 覆盖优先，否则用 type/host/port(/账号密码)。host 为空则无代理。 */
export function buildProxyUrl(p: ProxyConfig): string | undefined {
  if (p.url.trim()) return p.url.trim();
  if (!p.host.trim()) return undefined;
  const auth = p.username.trim()
    ? `${encodeURIComponent(p.username.trim())}:${encodeURIComponent(p.password)}@`
    : "";
  const port = p.port.trim() ? `:${p.port.trim()}` : "";
  return `${p.type}://${auth}${p.host.trim()}${port}`;
}

/** 目标主机是否命中「不走代理」列表（前缀 . 表示域名后缀匹配）。 */
export function isHostBypassed(noProxy: string, hostname: string): boolean {
  return noProxy
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((entry) =>
      entry.startsWith(".") ? hostname === entry.slice(1) || hostname.endsWith(entry) : hostname === entry,
    );
}

/** 深合并补丁到配置（proxy/appearance 为浅层子对象）。 */
export function mergeConfig(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  return normalizeConfig({
    ...base,
    ...patch,
    proxy: { ...base.proxy, ...(patch.proxy ?? {}) },
    appearance: { ...base.appearance, ...(patch.appearance ?? {}) },
  });
}
