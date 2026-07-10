/** 应用配置（config.toml 的形状）。只放非敏感项——API Key 仍在 Keychain（NFR-001）。 */
export type ProxyMode = "off" | "auto" | "custom";

export type AppConfig = {
  language: "zh-CN" | "zh-TW" | "en";
  theme: "light" | "dark";
  /** 关闭窗口时：后台驻留 / 直接退出 */
  closeBehavior: "background" | "quit";
  proxy: { mode: ProxyMode; url: string };
  appearance: { fontSize: number; fontFamily: string };
};

export const DEFAULT_CONFIG: AppConfig = {
  language: "zh-CN",
  theme: "light",
  closeBehavior: "background",
  proxy: { mode: "off", url: "" },
  appearance: { fontSize: 14, fontFamily: "system" },
};

const LANGS = ["zh-CN", "zh-TW", "en"] as const;
const THEMES = ["light", "dark"] as const;
const CLOSE = ["background", "quit"] as const;
const PROXY = ["off", "auto", "custom"] as const;

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
    proxy: {
      mode: pick(PROXY, proxy.mode, DEFAULT_CONFIG.proxy.mode),
      url: typeof proxy.url === "string" ? proxy.url : "",
    },
    appearance: {
      fontSize: Number.isFinite(size) && size >= 10 && size <= 24 ? size : DEFAULT_CONFIG.appearance.fontSize,
      fontFamily: typeof appearance.fontFamily === "string" ? appearance.fontFamily : DEFAULT_CONFIG.appearance.fontFamily,
    },
  };
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
