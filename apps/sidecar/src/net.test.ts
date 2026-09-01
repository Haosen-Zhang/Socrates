import { describe, expect, it } from "bun:test";
import { DEFAULT_CONFIG, type AppConfig } from "@socrates/core";
import { parseMacSystemProxy, resolveProxyFor } from "./net";

const cfg = (over: Partial<AppConfig["proxy"]>): AppConfig => ({
  ...DEFAULT_CONFIG,
  proxy: { ...DEFAULT_CONFIG.proxy, ...over },
});

const TARGET = "https://api.openai.com/v1/models";
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

function withoutProxyEnv<T>(run: () => T): T {
  const previous = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  try {
    return run();
  } finally {
    for (const key of PROXY_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

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

  it("auto → macOS system proxy when the sidecar has no proxy env", () => {
    const scutilOutput = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 6789
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 6789
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 6789
  SOCKSProxy : 127.0.0.1
}`;

    withoutProxyEnv(() => {
      expect(
        resolveProxyFor(cfg({ mode: "auto" }), TARGET, {
          platform: "darwin",
          readMacSystemProxy: () => scutilOutput,
        }),
      ).toBe("http://127.0.0.1:6789");
    });
  });

  it("auto → proxy env keeps precedence over macOS system settings", () => {
    let systemRead = false;
    expect(
      resolveProxyFor(cfg({ mode: "auto" }), TARGET, {
        env: { HTTPS_PROXY: "http://env-proxy:1080" },
        platform: "darwin",
        readMacSystemProxy: () => {
          systemRead = true;
          return "HTTPSEnable : 1\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 6789";
        },
      }),
    ).toBe("http://env-proxy:1080");
    expect(systemRead).toBeFalse();
  });
});

describe("parseMacSystemProxy", () => {
  const output = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 8080
  HTTPProxy : web-proxy.local
  HTTPSEnable : 0
  HTTPSPort : 8443
  HTTPSProxy : secure-proxy.local
  SOCKSEnable : 1
  SOCKSPort : 1080
  SOCKSProxy : socks-proxy.local
}`;

  it("uses the enabled HTTP proxy for HTTP and as HTTPS fallback", () => {
    expect(parseMacSystemProxy(output, "http://example.com")).toBe("http://web-proxy.local:8080");
    expect(parseMacSystemProxy(output, "https://example.com")).toBe("http://web-proxy.local:8080");
  });

  it("falls back to SOCKS when web proxies are disabled", () => {
    const socksOnly = output.replace("HTTPEnable : 1", "HTTPEnable : 0");
    expect(parseMacSystemProxy(socksOnly, TARGET)).toBe("socks5://socks-proxy.local:1080");
  });

  it("ignores disabled or invalid proxy records", () => {
    expect(parseMacSystemProxy("HTTPEnable : 0\nHTTPProxy : host\nHTTPPort : 8080", TARGET)).toBeUndefined();
    expect(parseMacSystemProxy("HTTPSEnable : 1\nHTTPSProxy : host\nHTTPSPort : nope", TARGET)).toBeUndefined();
  });
});
