import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, type AppConfig } from "@socrates/core";
import { resolveProxy } from "./net";

const cfg = (over: Partial<AppConfig["proxy"]>): AppConfig => ({
  ...DEFAULT_CONFIG,
  proxy: { ...DEFAULT_CONFIG.proxy, ...over },
});

describe("resolveProxy", () => {
  it("off → no proxy", () => {
    expect(resolveProxy(cfg({ mode: "off", url: "http://x" }))).toBeUndefined();
  });
  it("custom → the configured url, empty → undefined", () => {
    expect(resolveProxy(cfg({ mode: "custom", url: "http://127.0.0.1:7890" }))).toBe("http://127.0.0.1:7890");
    expect(resolveProxy(cfg({ mode: "custom", url: "  " }))).toBeUndefined();
  });
  it("auto → env proxy when present", () => {
    const prev = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://env-proxy:1080";
    try {
      expect(resolveProxy(cfg({ mode: "auto" }))).toBe("http://env-proxy:1080");
    } finally {
      if (prev === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prev;
    }
  });
});
