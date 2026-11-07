import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "./store/migrations";
import { migrations } from "./store/migrations/index";
import { SessionStore } from "./store/session-store";
import { normalizeTokenUsage, UsageCollector } from "./services/usage-collector";

test("the production sidecar launched from desktop upgrades an applied early 023 and completes handshake plus authenticated bootstrap", async () => {
  const directory = mkdtempSync(join(tmpdir(), "socrates-startup-upgrade-"));
  const path = join(directory, "socrates.db"), db = new Database(path);
  let process: ReturnType<typeof Bun.spawn> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    runMigrations(db, migrations.filter(m => m.version <= 22));
    const room = new SessionStore(db).create({ title: "Startup preserved room", mode: "chat", primaryAgentId: "fixture", agents: [{ agentId: "fixture", snapshot: {}, executionEligible: true }] });
    new UsageCollector(db).record({ stableKey: "old-usage", sessionId: room.id, usage: normalizeTokenUsage({ inputTokens: 10, outputTokens: 5 }) });
    db.exec(readFileSync(new URL("./store/migrations/fixtures/023_early_cost_schema.sql", import.meta.url), "utf8"));
    db.query("INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (23,'cost_invocations_prices_budgets','c31ffcef6816265e8f707e3ce5625c3add8169b6b1ac2a92531f492814d738ff','2026-11-06T00:00:00Z')").run();
    db.close();
    process = Bun.spawn([Bun.which("bun")!, "run", resolve(import.meta.dir, "index.ts")], {
      cwd: resolve(import.meta.dir, "../../desktop"), env: { ...Bun.env, SOCRATES_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe",
    });
    const stderr = new Response(process.stderr as ReadableStream).text();
    const handshake = await Promise.race([
      (async () => {
        let buffer = "";
        const decoder = new TextDecoder();
        const reader = (process!.stdout as ReadableStream<Uint8Array>).getReader();
        try { while (true) {
          const { value: chunk, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n"); buffer = lines.pop()!;
          for (const line of lines) {
            try {
              const data = JSON.parse(line) as { protocol?: string; port: number; token: string };
              if (data.protocol === "socrates-sidecar/1") return data;
            } catch { /* Not a handshake line. */ }
          }
        } } finally { reader.releaseLock(); }
        throw new Error(`sidecar_exited_before_handshake:${await stderr}`);
      })(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("sidecar_handshake_timeout")), 10_000); }),
    ]);
    const headers = { Authorization: `Bearer ${handshake.token}` }, base = `http://127.0.0.1:${handshake.port}`;
    expect((await fetch(`${base}/health`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/health`)).status).toBe(401);
    const sessions = await (await fetch(`${base}/sessions`, { headers })).json() as Array<{ id: string; title: string }>;
    expect(sessions).toContainEqual(expect.objectContaining({ id: room.id, title: "Startup preserved room" }));
    expect((await fetch(`${base}/agent/capabilities`, { headers })).status).toBe(200);
    const cost = await (await fetch(`${base}/cost/rooms/${room.id}`, { headers })).json() as { summary: { historicalUnknownCount: number; invocations: number } };
    expect(cost.summary).toMatchObject({ historicalUnknownCount: 1, invocations: 0 });
    const verified = new Database(path, { readonly: true });
    try {
      expect(verified.query("SELECT version FROM schema_migrations WHERE version=24").get()).toEqual({ version: 24 });
      expect(verified.query("SELECT checksum FROM schema_migrations WHERE version=23").get()).toEqual({ checksum: "c31ffcef6816265e8f707e3ce5625c3add8169b6b1ac2a92531f492814d738ff" });
    } finally { verified.close(); }
  } finally {
    if (timeout) clearTimeout(timeout);
    if (process) { process.kill("SIGTERM"); await process.exited; }
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
