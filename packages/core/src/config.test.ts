import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, buildProxyUrl, isHostBypassed, mergeConfig, normalizeConfig } from "./config";

describe("buildProxyUrl / isHostBypassed", () => {
  const base = DEFAULT_CONFIG.proxy;
  it("builds from parts and honors url override", () => {
    expect(buildProxyUrl({ ...base, host: "127.0.0.1", port: "7890", type: "socks5" })).toBe("socks5://127.0.0.1:7890");
    expect(buildProxyUrl({ ...base, host: "x", url: "http://p:1" })).toBe("http://p:1");
    expect(buildProxyUrl({ ...base, host: "" })).toBeUndefined();
  });

  it("reinjects Keychain credentials into a redacted proxy URL only at runtime", () => {
    expect(buildProxyUrl({
      ...DEFAULT_CONFIG.proxy,
      mode: "custom", url: "http://127.0.0.1:6789/", username: "proxy user", password: "p@ss",
    })).toBe("http://proxy%20user:p%40ss@127.0.0.1:6789/");
  });
  it("matches exact hosts and dot-suffix domains", () => {
    expect(isHostBypassed("localhost,127.0.0.1,.local", "localhost")).toBeTrue();
    expect(isHostBypassed("localhost,.local", "printer.local")).toBeTrue();
    expect(isHostBypassed("localhost", "api.openai.com")).toBeFalse();
  });
});

describe("normalizeConfig", () => {
  it("returns defaults for empty/garbage input", () => {
    expect(normalizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig("nonsense")).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({ language: "fr", theme: "neon", proxy: { mode: "hack" } })).toEqual(DEFAULT_CONFIG);
  });

  it("keeps valid fields and clamps font size", () => {
    const c = normalizeConfig({
      language: "en",
      theme: "dark",
      closeBehavior: "quit",
      proxy: { mode: "custom", type: "socks5", host: "127.0.0.1", port: "7890" },
      appearance: { fontSize: 99, fontFamily: "Menlo", uiTheme: "pixel-1998" },
    });
    expect(c.language).toBe("en");
    expect(c.theme).toBe("dark");
    expect(c.closeBehavior).toBe("quit");
    expect(c.proxy.mode).toBe("custom");
    expect(c.proxy.type).toBe("socks5");
    expect(c.proxy.host).toBe("127.0.0.1");
    expect(c.proxy.port).toBe("7890");
    expect(c.proxy.noProxy).toBe(DEFAULT_CONFIG.proxy.noProxy); // default filled in
    expect(c.appearance.fontSize).toBe(DEFAULT_CONFIG.appearance.fontSize); // 99 out of range → default
    expect(c.appearance.fontFamily).toBe("Menlo");
    expect(c.appearance.uiTheme).toBe("pixel-1998");
  });

  it("falls back to Socrates Classic for an unknown UI theme", () => {
    const c = normalizeConfig({ appearance: { uiTheme: "future-neon" } });
    expect(c.appearance.uiTheme).toBe("socrates-classic");
  });

  it("persists the OpenCode-inspired flat theme", () => {
    expect(normalizeConfig({ appearance: { uiTheme: "opencode-flat" } }).appearance.uiTheme).toBe("opencode-flat");
  });
});

describe("mergeConfig", () => {
  it("shallow-merges nested proxy/appearance without dropping siblings", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { proxy: { mode: "auto" } as never });
    expect(merged.proxy.mode).toBe("auto");
    expect(merged.proxy.noProxy).toBe(DEFAULT_CONFIG.proxy.noProxy); // sibling preserved
    const themed = mergeConfig(merged, { theme: "dark" });
    expect(themed.theme).toBe("dark");
    expect(themed.proxy.mode).toBe("auto"); // earlier patch preserved
  });

  it("deep-merges collaboration defaults without discarding retained discussion fields", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      collaborationDefaults: {
        discussion: { enabled: true },
      } as never,
    });
    expect(merged.collaborationDefaults.discussion).toMatchObject({
      enabled: true,
      mode: "round_robin",
      maxRounds: 2,
    });
    expect(merged.collaborationDefaults.strategy).toBe("single");
  });
});

describe("sidebar prefs (C3)", () => {
  it("defaults to expanded with a sane width", () => {
    expect(DEFAULT_CONFIG.sidebar).toEqual({ collapsed: false, width: 256, dockWidth: 420 });
  });

  it("persists a collapsed sidebar and clamps out-of-range widths", () => {
    expect(normalizeConfig({ sidebar: { collapsed: true, width: 300 } }).sidebar).toEqual({
      collapsed: true,
      width: 300,
      dockWidth: 420,
    });
    expect(normalizeConfig({ sidebar: { width: 9999 } }).sidebar.width).toBe(480);
    expect(normalizeConfig({ sidebar: { width: 10 } }).sidebar.width).toBe(180);
    expect(normalizeConfig({ sidebar: { collapsed: "yes" } }).sidebar.collapsed).toBeFalse();
    expect(normalizeConfig({ sidebar: { dockWidth: 520 } }).sidebar.dockWidth).toBe(520);
    expect(normalizeConfig({ sidebar: { dockWidth: 900 } }).sidebar.dockWidth).toBe(640);
  });

  it("merging a partial sidebar patch keeps the sibling field", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { sidebar: { collapsed: true } as never });
    expect(merged.sidebar).toEqual({ collapsed: true, width: 256, dockWidth: 420 });
  });
});
