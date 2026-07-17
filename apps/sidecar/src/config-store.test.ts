import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { ConfigStore, configRoutes } from "./config-store";
import { MemorySecrets, type SecretStore } from "./secrets";

function tmpPath() {
  return `${tmpdir()}/socrates-config-${crypto.randomUUID()}.toml`;
}

describe("ConfigStore", () => {
  it("creates a default file when missing and round-trips updates", () => {
    const path = tmpPath();
    try {
      const store = new ConfigStore(path);
      expect(store.get().theme).toBe("light");
      store.update({ theme: "dark", proxy: { mode: "custom", type: "socks5", host: "127.0.0.1", port: "7890" } as never });
      // reload from disk proves persistence
      const reopened = new ConfigStore(path);
      expect(reopened.get().theme).toBe("dark");
      expect(reopened.get().proxy.mode).toBe("custom");
      expect(reopened.get().proxy.host).toBe("127.0.0.1");
      expect(reopened.get().proxy.type).toBe("socks5");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("recovers from a corrupt file", () => {
    const path = tmpPath();
    try {
      Bun.write(path, "this is not = valid = toml ===");
      const store = new ConfigStore(path);
      expect(store.get().theme).toBe("light"); // fell back to defaults
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("PUT merges and GET returns current config", async () => {
    const path = tmpPath();
    try {
      const app = new Hono().route("/config", configRoutes(new ConfigStore(path)));
      const put = await app.request("/config", { method: "PUT", body: JSON.stringify({ language: "en" }) });
      expect((await put.json()).language).toBe("en");
      const get = await app.request("/config");
      expect((await get.json()).language).toBe("en");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("moves proxy credentials and URL userinfo to Keychain refs without exposing them", () => {
    const path = tmpPath();
    const secrets = new MemorySecrets();
    try {
      const store = new ConfigStore(path, secrets);
      store.update({ proxy: {
        mode: "custom", type: "http", host: "", port: "", username: "alice", password: "secret",
        url: "http://url-user:url-pass@127.0.0.1:6789", noProxy: "localhost",
      } });
      expect(store.get().proxy).toMatchObject({ username: "", password: "", url: "http://127.0.0.1:6789/" });
      expect(store.getResolved().proxy).toMatchObject({ username: "url-user", password: "url-pass" });
      expect(readFileSync(path, "utf8")).not.toContain("url-pass");
      expect(readFileSync(path, "utf8")).not.toContain("alice");
      const reopened = new ConfigStore(path, secrets);
      expect(reopened.getResolved().proxy.password).toBe("url-pass");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("does not rewrite TOML when the Keychain write fails", () => {
    const path = tmpPath();
    const values = new Map<string, string>();
    const failing: SecretStore = {
      set(ref, value) { if (ref === "proxy:password") throw new Error("keychain_locked"); values.set(ref, value); },
      get(ref) { return values.get(ref) ?? null; },
      delete(ref) { values.delete(ref); },
    };
    try {
      const store = new ConfigStore(path, failing);
      const before = readFileSync(path, "utf8");
      expect(() => store.update({ proxy: { ...store.get().proxy, username: "alice", password: "secret" } })).toThrow("keychain_locked");
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(values.size).toBe(0);
    } finally {
      rmSync(path, { force: true });
    }
  });
});
