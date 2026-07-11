import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, type AppConfig } from "@socrates/core";
import { resolveProxyFor } from "./net";

const cfg = (over: Partial<AppConfig["proxy"]>): AppConfig => ({
  ...DEFAULT_CONFIG,
  proxy: { ...DEFAULT_CONFIG.proxy, ...over },
});

const TARGET = "https://api.openai.com/v1/models";

describe("resolveProxyFor", () => {
  it("off → no proxy", () => {
    expect(resolveProxyFor(cfg({ mode: "off", host: "127.0.0.1", port: "7890" }), TARGET)).toBeUndefined();
  });
  it("custom → builds url from type/host/port", () => {
    expect(resolveProxyFor(cfg({ mode: "custom", type: "socks5", host: "127.0.0.1", port: "7890" }), TARGET)).toBe(
      "socks5://127.0.0.1:7890",
    );
  });
  it("custom → url override wins", () => {
    expect(
      resolveProxyFor(cfg({ mode: "custom", host: "1.2.3.4", port: "1", url: "http://127.0.0.1:8080" }), TARGET),
    ).toBe("http://127.0.0.1:8080");
  });
  it("custom → auth embedded", () => {
    expect(
      resolveProxyFor(cfg({ mode: "custom", host: "h", port: "1", username: "u", password: "p@ss" }), TARGET),
    ).toBe("http://u:p%40ss@h:1");
  });
  it("noProxy host → direct even in custom mode", () => {
    expect(
      resolveProxyFor(cfg({ mode: "custom", host: "127.0.0.1", port: "7890" }), "http://localhost:1420/health"),
    ).toBeUndefined();
  });
  it("auto → env proxy", () => {
    const prev = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://env-proxy:1080";
    try {
      expect(resolveProxyFor(cfg({ mode: "auto" }), TARGET)).toBe("http://env-proxy:1080");
    } finally {
      if (prev === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prev;
    }
  });
});
