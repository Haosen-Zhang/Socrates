import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse, stringify } from "smol-toml";
import { mergeConfig, normalizeConfig, type AppConfig } from "@socrates/core";

function defaultConfigPath(): string {
  const dir =
    process.env.SOCRATES_DATA_DIR ?? `${homedir()}/Library/Application Support/dev.haosen.socrates`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/config.toml`;
}

/** config.toml 读写。文件缺失/损坏时回退默认并重写，保证永远有一份合法配置。 */
export class ConfigStore {
  private cache: AppConfig;
  constructor(private path = defaultConfigPath()) {
    this.cache = this.load();
  }

  private load(): AppConfig {
    if (!existsSync(this.path)) {
      const cfg = normalizeConfig(undefined);
      this.persist(cfg);
      return cfg;
    }
    try {
      return normalizeConfig(parse(readFileSync(this.path, "utf8")));
    } catch {
      const cfg = normalizeConfig(undefined);
      this.persist(cfg);
      return cfg;
    }
  }

  private persist(cfg: AppConfig): void {
    writeFileSync(this.path, stringify(cfg as unknown as Record<string, unknown>));
  }

  get(): AppConfig {
    return this.cache;
  }

  update(patch: Partial<AppConfig>): AppConfig {
    this.cache = mergeConfig(this.cache, patch);
    this.persist(this.cache);
    return this.cache;
  }
}

export function configRoutes(store: ConfigStore) {
  const app = new Hono();
  app.get("/", (c) => c.json(store.get()));
  app.put("/", async (c) => {
    const patch = (await c.req.json()) as Partial<AppConfig>;
    return c.json(store.update(patch));
  });
  return app;
}
