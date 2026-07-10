import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, mergeConfig, normalizeConfig } from "./config";

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
      proxy: { mode: "custom", url: "http://127.0.0.1:7890" },
      appearance: { fontSize: 99, fontFamily: "Menlo" },
    });
    expect(c.language).toBe("en");
    expect(c.theme).toBe("dark");
    expect(c.closeBehavior).toBe("quit");
    expect(c.proxy).toEqual({ mode: "custom", url: "http://127.0.0.1:7890" });
    expect(c.appearance.fontSize).toBe(DEFAULT_CONFIG.appearance.fontSize); // 99 out of range → default
    expect(c.appearance.fontFamily).toBe("Menlo");
  });
});

describe("mergeConfig", () => {
  it("shallow-merges nested proxy/appearance without dropping siblings", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { proxy: { mode: "auto" } as never });
    expect(merged.proxy.mode).toBe("auto");
    expect(merged.proxy.url).toBe(""); // sibling preserved
    const themed = mergeConfig(merged, { theme: "dark" });
    expect(themed.theme).toBe("dark");
    expect(themed.proxy.mode).toBe("auto"); // earlier patch preserved
  });
});
