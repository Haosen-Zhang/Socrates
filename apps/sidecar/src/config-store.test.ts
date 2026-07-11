import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { ConfigStore, configRoutes } from "./config-store";

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
});
