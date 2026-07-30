import { Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { parse, stringify } from "smol-toml";
import {
  mergeConfig,
  normalizeConfig,
  validateCollaborationCapabilities,
  type AppConfig,
} from "@socrates/core";
import { MemorySecrets, type SecretStore } from "./secrets";

const PROXY_USERNAME_REF = "proxy:username";
const PROXY_PASSWORD_REF = "proxy:password";

function defaultConfigPath(): string {
  const dir =
    process.env.SOCRATES_DATA_DIR ?? `${homedir()}/Library/Application Support/dev.haosen.socrates`;
  mkdirSync(dir, { recursive: true });
  return `${dir}/config.toml`;
}

/** config.toml 读写。文件缺失/损坏时回退默认并重写，保证永远有一份合法配置。 */
export class ConfigStore {
  private cache: AppConfig;
  constructor(private path = defaultConfigPath(), private readonly secrets: SecretStore = new MemorySecrets()) {
    this.cache = this.load();
    this.migrateProxyCredentials();
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
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temporary, stringify(cfg as unknown as Record<string, unknown>), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  get(): AppConfig {
    return this.withoutProxyCredentials(this.cache);
  }

  getResolved(): AppConfig {
    return {
      ...this.cache,
      proxy: {
        ...this.cache.proxy,
        username: this.secrets.get(PROXY_USERNAME_REF) ?? "",
        password: this.secrets.get(PROXY_PASSWORD_REF) ?? "",
      },
    };
  }

  update(patch: Partial<AppConfig>): AppConfig {
    const incoming = mergeConfig(this.cache, patch);
    const collaborationErrors = validateCollaborationCapabilities(
      incoming.collaborationDefaults,
    );
    if (collaborationErrors.length) throw new Error(collaborationErrors[0]);
    const extracted = this.extractProxyCredentials(incoming);
    const oldUsername = this.secrets.get(PROXY_USERNAME_REF);
    const oldPassword = this.secrets.get(PROXY_PASSWORD_REF);
    try {
      if (extracted.username !== undefined) this.writeSecret(PROXY_USERNAME_REF, extracted.username);
      if (extracted.password !== undefined) this.writeSecret(PROXY_PASSWORD_REF, extracted.password);
      this.persist(extracted.config);
      this.cache = extracted.config;
    } catch (error) {
      this.restoreSecret(PROXY_USERNAME_REF, oldUsername);
      this.restoreSecret(PROXY_PASSWORD_REF, oldPassword);
      throw error;
    }
    return this.get();
  }

  private migrateProxyCredentials(): void {
    const extracted = this.extractProxyCredentials(this.cache);
    if (extracted.username === undefined && extracted.password === undefined && extracted.config.proxy.url === this.cache.proxy.url) return;
    const oldUsername = this.secrets.get(PROXY_USERNAME_REF);
    const oldPassword = this.secrets.get(PROXY_PASSWORD_REF);
    try {
      if (extracted.username !== undefined) this.writeSecret(PROXY_USERNAME_REF, extracted.username);
      if (extracted.password !== undefined) this.writeSecret(PROXY_PASSWORD_REF, extracted.password);
      this.persist(extracted.config);
      this.cache = extracted.config;
    } catch (error) {
      this.restoreSecret(PROXY_USERNAME_REF, oldUsername);
      this.restoreSecret(PROXY_PASSWORD_REF, oldPassword);
      throw new Error(`proxy_credential_migration_failed:${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private extractProxyCredentials(config: AppConfig): { config: AppConfig; username?: string; password?: string } {
    let username = config.proxy.username || undefined;
    let password = config.proxy.password || undefined;
    let url = config.proxy.url;
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.username) username = decodeURIComponent(parsed.username);
        if (parsed.password) password = decodeURIComponent(parsed.password);
        if (parsed.username || parsed.password) {
          parsed.username = "";
          parsed.password = "";
          url = parsed.toString();
        }
      } catch {
        // Existing validation and fetch error reporting handle malformed proxy URLs.
      }
    }
    return {
      config: { ...config, proxy: { ...config.proxy, url, username: "", password: "" } },
      ...(username !== undefined ? { username } : {}),
      ...(password !== undefined ? { password } : {}),
    };
  }

  private withoutProxyCredentials(config: AppConfig): AppConfig {
    return { ...config, proxy: { ...config.proxy, username: "", password: "" } };
  }

  private writeSecret(ref: string, value: string): void {
    if (value) this.secrets.set(ref, value);
    else this.secrets.delete(ref);
  }

  private restoreSecret(ref: string, value: string | null): void {
    if (value === null) this.secrets.delete(ref);
    else this.secrets.set(ref, value);
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
