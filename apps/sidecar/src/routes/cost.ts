import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { SessionStore } from "../store/session-store";
import type { ModelInvocationBroker } from "../services/model-invocation-broker";
import type { TaskQuoteService, QuoteInput } from "../services/task-quotes";
import type { CostTaskService } from "../services/cost-task-service";
import type { RoomCommandService } from "../services/room-command-service";
import { MAX_AUTOMATIC_OUTPUT_TOKENS, type PriceInput } from "@socrates/core";
import { modelProtocol } from "../gateway-aisdk";

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,12})?$/);
const priceSchema = z.object({ providerConnectionId: z.string().min(1), modelId: z.string().min(1), protocol: z.string().min(1), baseUrl: z.string(),
  currency: z.string().regex(/^[A-Z]{3,8}$/), rates: z.object({ input: decimal, output: decimal, cacheRead: decimal.optional(), cacheWrite: decimal.optional() }),
  source: z.literal("user_confirmed"), sourceVersion: z.string().min(1), billingMode: z.enum(["metered", "subscription", "local", "unknown"]).optional(),
  explicitlyFree: z.boolean().optional(), validUntil: z.string().datetime().nullable().optional(), serviceTier: z.string().optional(),
  usageSemantics: z.object({ inputIncludesCacheRead: z.boolean(), inputIncludesCacheWrite: z.boolean(), outputIncludesReasoning: z.boolean() }).optional(),
  unsupportedDimensions: z.array(z.string()).optional() });

export function costRoutes(db: Database, sessions: SessionStore, broker: ModelInvocationBroker, quotes: TaskQuoteService,
  tasks: CostTaskService, commands: RoomCommandService): Hono {
  const app = new Hono();
  const failure = (error: unknown) => ({ error: error instanceof Error ? error.message : "cost_request_failed" });
  const checkProvider = (id: string, baseUrl: string) => {
    const provider = db.query<{ base_url: string }, [string]>("SELECT base_url FROM providers WHERE id=?").get(id);
    if (!provider || provider.base_url !== baseUrl) throw new Error("price_provider_mapping_invalid");
  };
  const view = (rootTaskId: string) => ({ rootTaskId, summary: broker.ledger.summary({ rootTaskId }), invocations: broker.ledger.list({ rootTaskId }),
    budget: broker.budgets.get(rootTaskId) ? broker.budgets.summary(rootTaskId) : null, command: commands.get(rootTaskId), blocked: broker.budgets.latestBlocked(rootTaskId) });
  app.get("/prices", c => {
    const id = c.req.query("providerId");
    if (id) {
      const provider = db.query<{ type: "anthropic" | "openai_compatible"; base_url: string; default_model: string | null }, [string]>("SELECT type,base_url,default_model FROM providers WHERE id=?").get(id);
      if (provider) {
        const models = new Set(db.query<{ model_id: string }, [string]>("SELECT model_id FROM agents WHERE provider_id=?").all(id).map(row => row.model_id));
        if (provider.default_model) models.add(provider.default_model);
        for (const modelId of models) try {
          broker.prices.resolveAutomatic({ providerConnectionId: id, modelId, baseUrl: provider.base_url, protocol: modelProtocol(provider.type, provider.base_url) });
        } catch { /* Existing custom snapshots remain accessible for unsupported endpoints. */ }
      }
    }
    return c.json(broker.prices.list(id));
  });
  app.post("/prices", async c => {
    const parsed = priceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_price", details: parsed.error.issues }, 400);
    try { checkProvider(parsed.data.providerConnectionId, parsed.data.baseUrl); return c.json(broker.prices.save(parsed.data as PriceInput), 201); }
    catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/prices/import", async c => {
    const schema = z.object({ providerConnectionId: z.string(), modelId: z.string(), catalogProviderId: z.string(), catalogModelId: z.string().optional(),
      protocol: z.string(), baseUrl: z.string(), confirmedMapping: z.boolean().optional(), serviceTier: z.string().optional() });
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_catalog_mapping" }, 400);
    try { checkProvider(parsed.data.providerConnectionId, parsed.data.baseUrl); return c.json(broker.prices.importBundledModelsDev(parsed.data), 201); }
    catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/quotes", async c => {
    const parsed = z.object({ roomId: z.string(), content: z.string(), intent: z.enum(["respond", "discuss", "execute"]), mentions: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("agent"), agentId: z.string() }), z.object({ type: z.literal("squad"), squadId: z.string().min(1) }), z.object({ type: z.literal("all") }), z.object({ type: z.literal("file"), refId: z.string() })])),
      verificationPlanId: z.string().min(1).optional(), routingCandidateId: z.string().min(1).optional(),
      maxOutputTokens: z.number().int().min(1).max(32_768).optional(), attachmentIds: z.array(z.string()).optional(), workspaceRefIds: z.array(z.string()).optional(),
      budget: z.object({ mode: z.enum(["soft_limit", "strict_admission", "tracking_only"]), limitAtomic: z.string().regex(/^(0|[1-9]\d*)$/) }).optional(),
    }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_quote" }, 400);
    try { return c.json(quotes.quote(parsed.data as QuoteInput), 201); } catch (error) { return c.json(failure(error), 409); }
  });
  app.get("/rooms/:roomId", c => {
    const roomId = c.req.param("roomId"); if (!sessions.get(roomId)) return c.json({ error: "room_not_found" }, 404);
    const ledger = broker.ledger.list({ roomId });
    const roots = [...new Set([...commands.list(roomId).map(command => command.commandId), ...ledger.map(i => i.rootTaskId)])];
    return c.json({ summary: broker.ledger.summary({ roomId }), invocations: ledger, tasks: roots.map(rootTaskId => {
      const command = commands.get(rootTaskId);
      const original = db.query<{ input_json: string }, [string]>("SELECT input_json FROM room_commands WHERE id=?").get(rootTaskId);
      const options = original ? JSON.parse(original.input_json) as { maxOutputTokens?: number } : {};
      return { rootTaskId, commandId: command?.commandId, kind: command?.kind, status: command?.status ?? "history_removed",
        budget: broker.budgets.get(rootTaskId) ? broker.budgets.summary(rootTaskId) : null,
        blocked: broker.budgets.latestBlocked(rootTaskId), maxOutputTokens: tasks.configuration(rootTaskId)?.maxOutputTokens ?? options.maxOutputTokens ?? MAX_AUTOMATIC_OUTPUT_TOKENS };
    }) });
  });
  app.get("/tasks/:rootTaskId", c => c.json(view(c.req.param("rootTaskId"))));
  app.post("/tasks/:rootTaskId/increase", async c => {
    const parsed = z.object({ requestId: z.string().min(1).max(200), expectedRevision: z.number().int().min(1), amountAtomic: z.string().regex(/^[1-9]\d*$/) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_budget_increase" }, 400);
    try { return c.json(broker.budgets.increase(c.req.param("rootTaskId"), parsed.data)); } catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/tasks/:rootTaskId/resume", async c => {
    const parsed = z.object({ requestId: z.string().min(1).max(200), maxOutputTokens: z.number().int().min(1).max(32_768).optional() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_cost_resume" }, 400);
    try { return c.json(await tasks.resume(c.req.param("rootTaskId"), parsed.data), 202); } catch (error) { return c.json(failure(error), 409); }
  });
  app.post("/invocations/:id/reconcile", async c => {
    const parsed = z.object({ requestId: z.string().min(1), totalAtomic: z.string().regex(/^(0|[1-9]\d*)$/), currency: z.string().regex(/^[A-Z]{3,8}$/), reason: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_reconciliation" }, 400);
    try { broker.ledger.reconcile(c.req.param("id"), parsed.data); return c.json(broker.ledger.get(c.req.param("id"))); } catch (error) { return c.json(failure(error), 409); }
  });
  app.get("/rooms/:roomId/export", c => {
    const roomId = c.req.param("roomId"); if (!sessions.get(roomId)) return c.json({ error: "room_not_found" }, 404);
    const invocations = broker.ledger.list({ roomId }), summary = broker.ledger.summary({ roomId }), generatedAt = new Date().toISOString();
    if (c.req.query("format") === "csv") {
      const numericColumns = new Set([8, 9, 10, 13, 15, 17]);
      const escapeCsvCell = (value: unknown, column: number) => {
        const raw = String(value ?? "");
        const safe = !numericColumns.has(column) && /^\s*[=+\-@]/u.test(raw) ? `'${raw}` : raw;
        return `"${safe.replaceAll('"', '""')}"`;
      };
      const header = ["invocation_id", "root_task_id", "agent_id", "model_id", "purpose", "price_snapshot_id", "pricing_version", "currency", "original_amount_atomic", "reconciled_amount_atomic", "effective_amount_atomic", "reconciliation_request_id", "reconciliation_reason", "scale", "status", "unknown_count", "generated_at", "reference_estimate_atomic", "reference_estimate_currency", "reference_estimate_price_snapshot_id"];
      const rows = invocations.map(i => [i.invocationId, i.rootTaskId, i.agentId, i.modelId, i.purpose, i.priceSnapshotId,
        i.priceSnapshotId ? broker.prices.get(i.priceSnapshotId)?.sourceVersion : null,
        i.reconciliation?.amount.currency ?? i.amount?.currency, i.amount?.atomic, i.reconciliation?.amount.atomic,
        i.reconciliation?.amount.atomic ?? i.amount?.atomic, i.reconciliation?.requestId, i.reconciliation?.reason,
        12, i.status, summary.unknownCount, generatedAt, i.referenceEstimate?.amount.atomic, i.referenceEstimate?.amount.currency, i.referenceEstimate?.priceSnapshotId].map(escapeCsvCell).join(","));
      return c.text([header.join(","), ...rows].join("\n"), 200, { "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": 'attachment; filename="costs.csv"' });
    }
    return c.json({ schemaVersion: 1, generatedAt, summary, invocations, pricingVersions: [...new Set(invocations.flatMap(i => [i.priceSnapshotId, i.referenceEstimate?.priceSnapshotId].filter((id): id is string => !!id)))].map(id => broker.prices.get(id)) });
  });
  return app;
}
