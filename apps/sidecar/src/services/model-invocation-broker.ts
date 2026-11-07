import type { Database } from "bun:sqlite";
import {
  DEFAULT_MAX_OUTPUT_TOKENS, MAX_AUTOMATIC_OUTPUT_TOKENS, requestCostUpperBound, StructuredExecutionError,
  type GatewayEvent, type GatewayInvocationContext, type InvocationIdentity,
  type ModelGateway, type ProviderType, type TokenUsage,
  type ReasoningEffort,
} from "@socrates/core";
import { CostLedger, BudgetLedger } from "./cost-ledger";
import { assertRoutingCallSlot, frozenInvocationRoute } from "./routing-admission";
import { PricingStore } from "./pricing-store";
import { EventStore } from "../store/event-store";
import { recordServiceEvent } from "./reuse/local-trace";
import { invocationModelOptions, modelProtocol } from "../gateway-aisdk";
export { modelProtocol } from "../gateway-aisdk";

export function isCostBudgetPause(error: unknown): boolean {
  return /^cost_budget_/.test(error instanceof Error ? error.message : String(error));
}

export interface InvocationRequest {
  context: GatewayInvocationContext; providerType: ProviderType; baseUrl: string; modelId: string;
  payload: unknown; maxOutputTokens?: number; signal?: AbortSignal;
  reasoningEffort?: ReasoningEffort; temperature?: number;
}
export interface InvocationObservation { usage?: TokenUsage; requestId?: string; finishReason?: string; failed?: boolean }

function unsupportedInputModalities(payload: unknown): string[] {
  const pending: unknown[] = [payload], seen = new Set<object>(), modalities = new Set<string>();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
    seen.add(value);
    const type = (value as { type?: unknown }).type;
    if (typeof type === "string" && ["image", "file", "audio", "input_audio", "video"].includes(type)) { modalities.add(type); continue; }
    pending.push(...Object.values(value));
  }
  return [...modalities].sort();
}

/** One request, one identity/reservation. The existing Native loop owns sampling and retries. */
export class ModelInvocationBroker {
  readonly prices: PricingStore;
  readonly ledger: CostLedger;
  readonly budgets: BudgetLedger;
  private readonly events: EventStore;
  constructor(private readonly db: Database, private readonly authorizeProvider?: (id: string) => void) {
    this.prices = new PricingStore(db); this.ledger = new CostLedger(db, this.prices);
    this.budgets = new BudgetLedger(db); this.events = new EventStore(db);
  }

  async *invoke<T>(request: InvocationRequest, open: (controls: { maxOutputTokens: number; outputTokenCeiling: number }) => AsyncIterable<T>,
    observe: (part: T) => InvocationObservation | undefined): AsyncIterable<T> {
    request.signal?.throwIfAborted();
    const context = request.context;
    this.assertCurrentPermission(context, request);
    invocationModelOptions(request);
    const command = this.db.query<{ input_json: string }, [string]>("SELECT input_json FROM room_commands WHERE id=? AND status!='revoked'").get(context.rootTaskId);
    const original = command ? JSON.parse(command.input_json) as { maxOutputTokens?: number; quoteId?: string } : {};
    const revised = this.db.query<{ result_json: string }, [string]>("SELECT result_json FROM cost_actions WHERE root_task_id=? AND kind='configuration' AND state='completed' ORDER BY rowid DESC LIMIT 1").get(context.rootTaskId);
    const options = revised ? { ...original, ...JSON.parse(revised.result_json) as { maxOutputTokens: number; quoteId: string } } : original;
    const outputTokenCeiling = options.maxOutputTokens ?? MAX_AUTOMATIC_OUTPUT_TOKENS;
    const maxOutputTokens = Math.min(request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, outputTokenCeiling);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32_768) throw new Error("invalid_output_cap");
    const route = frozenInvocationRoute(this.db,context,request);
    const price = route ? route.members[context.agentId]!.price : this.prices.resolveAutomatic({ providerConnectionId: context.providerConnectionId, modelId: request.modelId,
      protocol: modelProtocol(request.providerType, request.baseUrl), baseUrl: request.baseUrl });
    const modalities = unsupportedInputModalities(request.payload);
    const applicablePrice = modalities.length ? null : price;
    const identity: InvocationIdentity = {
      ...context, invocationId: crypto.randomUUID(), modelId: request.modelId,
      attemptNo: context.attemptNo ?? 1, traceId: context.rootTaskId, spanId: crypto.randomUUID(),
    };
    this.db.transaction(()=>{
      if(route)assertRoutingCallSlot(this.db,route);
      this.ledger.begin(identity, applicablePrice?.id ?? null);
    }).immediate();
    const account = this.budgets.get(context.rootTaskId);
    if (account) {
      let admissionDetails: Record<string, unknown> = {};
      try {
        let admissionMode = account.mode, ancestorId = account.parentId;
        let aggregateRoot = account.rootTaskId;
        const seen = new Set([aggregateRoot]);
        while (ancestorId) {
          if (seen.has(ancestorId)) throw new Error("cost_budget_parent_cycle");
          seen.add(ancestorId);
          const parent = this.budgets.get(ancestorId); if (!parent) throw new Error("cost_budget_parent_invalid");
          if (parent.mode === "strict_admission" || admissionMode === "tracking_only" && parent.mode === "soft_limit") admissionMode = parent.mode;
          aggregateRoot = parent.rootTaskId; ancestorId = parent.parentId;
        }
        if (admissionMode !== "tracking_only" && modalities.length) throw new Error("cost_budget_unpriced_modality");
        if (admissionMode !== "tracking_only" && this.ledger.list({ rootTaskId: aggregateRoot }).some(prior =>
          prior.usage?.unsupportedBillingDimensions?.length && !prior.reconciliation)) throw new Error("cost_budget_billing_rule_unknown");
        if (admissionMode !== "tracking_only" && price?.validUntil && Date.parse(price.validUntil) <= Date.now()) throw new Error("cost_budget_price_expired");
        if (admissionMode !== "tracking_only" && options.quoteId) {
          const frozenQuote = this.db.query<{ quote_json: string }, [string]>("SELECT quote_json FROM cost_quotes WHERE id=?").get(options.quoteId);
          const ids = frozenQuote ? (JSON.parse(frozenQuote.quote_json) as { priceSnapshotIds: string[] }).priceSnapshotIds : [];
          if (price && !ids.includes(price.id)) throw new Error("cost_budget_quote_reprice_required");
        }
        // A character heuristic is never evidence for strict admission. For
        // verified official endpoints use the model's full accepted context cap.
        const protocol = modelProtocol(request.providerType, request.baseUrl);
        const official = protocol === "openai_responses" || (protocol === "anthropic_messages" && new URL(request.baseUrl).hostname === "api.anthropic.com");
        const catalog = context.catalogContextWindow;
        const trustedCap = official && catalog && Number.isSafeInteger(catalog.tokens) && catalog.tokens > 0
          && catalog.providerId === (protocol === "openai_responses" ? "openai" : "anthropic") && !!catalog.revision
          && !modalities.length
          && price !== null && price.source !== "preset_estimate" && (!price.validUntil || Date.parse(price.validUntil) > Date.now());
        const estimatedInput = Math.max(1, new TextEncoder().encode(JSON.stringify(request.payload)).byteLength + 512);
        const inputTokenBound = admissionMode === "strict_admission" && trustedCap ? catalog!.tokens : estimatedInput;
        const bound = requestCostUpperBound(applicablePrice, inputTokenBound, maxOutputTokens);
        admissionDetails = { inputTokenBound, maxOutputTokens, priceSnapshotId: applicablePrice?.id ?? null };
        if (admissionMode !== "tracking_only" && (!bound || bound.currency !== "USD")) throw new Error("cost_budget_price_unknown");
        this.budgets.reserve(identity.invocationId, context.rootTaskId, bound?.atomic ?? "0", {
          strictEligible: Boolean(trustedCap && price && bound), reason: "cost_budget_strict_bound_unavailable",
        });
      } catch (error) {
        const reason = isCostBudgetPause(error) ? (error as Error).message : `cost_budget_${error instanceof Error ? error.message : "admission_failed"}`;
        this.ledger.finish(identity.invocationId, { outcome: "not_sent" });
        this.budgets.block(context.rootTaskId, reason, { ...this.budgets.latestBlocked(context.rootTaskId)?.details,
          ...admissionDetails, invocationId: identity.invocationId, logicalStepId: context.logicalStepId, agentId: context.agentId, modelId: request.modelId, purpose: context.purpose });
        this.event(identity, "budget.blocked", { reason });
        throw new StructuredExecutionError({ code: reason, message: reason, category: "invalid_request", phase: "provider_connect", retryable: false });
      }
    }
    let observation: InvocationObservation | undefined;
    let failed = false;
    try {
      request.signal?.throwIfAborted();
      this.assertCurrentPermission(context, request);
      frozenInvocationRoute(this.db,context,request);
      this.ledger.markSent(identity.invocationId);
      this.event(identity, "pricing.snapshot_selected", { priceSnapshotId: applicablePrice?.id ?? null });
      for await (const part of open({ maxOutputTokens, outputTokenCeiling })) {
        const next = observe(part);
        if (next) {
          failed ||= next.failed === true;
          if (next.usage || next.finishReason || next.requestId) observation = { ...observation, ...next,
            ...(next.usage && modalities.length ? { usage: { ...next.usage, unsupportedBillingDimensions: [
              ...(next.usage.unsupportedBillingDimensions ?? []), ...modalities.map(type => `unsupported_input_modality:${type}`),
            ] } } : {}) };
        }
        yield part;
      }
      this.ledger.finish(identity.invocationId, { ...observation, outcome: failed ? "failed" : "completed" });
    } catch (error) {
      // The remote request may have consumed tokens. Never refund on disconnect.
      const row = this.ledger.get(identity.invocationId);
      if (row?.state === "created") this.ledger.finish(identity.invocationId, { outcome: "not_sent" });
      else if (observation?.usage) this.ledger.finish(identity.invocationId, { ...observation, outcome: "failed" });
      else this.ledger.markUnknown(identity.invocationId);
      throw error;
    } finally {
      const row = this.ledger.get(identity.invocationId);
      // Also covers a consumer closing an iterator before finish.
      if (row?.state === "sent") this.ledger.markUnknown(identity.invocationId);
    }
  }

  wrapGateway(gateway: ModelGateway): ModelGateway {
    const broker = this;
    return async function* (request): AsyncIterable<GatewayEvent> {
      if (!request.invocation) throw new Error("model_invocation_identity_required");
      yield* broker.invoke({ context: request.invocation, providerType: request.providerType, baseUrl: request.baseUrl,
        modelId: request.modelId, payload: { system: request.system, messages: request.messages },
        maxOutputTokens: request.maxOutputTokens, signal: request.signal, reasoningEffort: request.reasoningEffort, temperature: request.temperature },
      async function* ({ maxOutputTokens, outputTokenCeiling }) {
        for await (const event of gateway({ ...request, maxOutputTokens })) {
          yield event.type === "done" ? { ...event, outputTokenLimit: maxOutputTokens, outputTokenCeiling } : event;
        }
      },
      event => event.type === "done" ? event : event.type === "error" ? { failed: true } : undefined);
    };
  }

  private assertCurrentPermission(context: GatewayInvocationContext, request: InvocationRequest): void {
    const provider = this.db.query<{ enabled: number; base_url: string; type: string }, [string]>("SELECT enabled,base_url,type FROM providers WHERE id=?").get(context.providerConnectionId);
    if (!provider?.enabled || provider.base_url !== request.baseUrl || provider.type !== request.providerType) throw new Error("invocation_provider_unavailable");
    this.authorizeProvider?.(context.providerConnectionId);
    const member = this.db.query<{ execution_eligible: number }, [string, string]>("SELECT execution_eligible FROM session_agents WHERE session_id=? AND agent_id=?").get(context.roomId, context.agentId);
    if (!member) throw new Error("invocation_member_unavailable");
    if (context.purpose === "execute" && !member.execution_eligible) throw new Error("invocation_execution_revoked");
    const room = this.db.query<{ archived: number }, [string]>("SELECT archived FROM sessions WHERE id=?").get(context.roomId);
    if (!room || room.archived) throw new Error("invocation_room_unavailable");
    if (this.db.query("SELECT id FROM room_commands WHERE id=? AND status='revoked'").get(context.rootTaskId)) throw new Error("room_command_revoked");
  }
  private event(identity: InvocationIdentity, type: string, payload: Record<string, unknown>): void {
    const committed = this.events.append({ eventId: `${type}:${identity.invocationId}`, sessionId: identity.roomId, taskId: identity.rootTaskId,
      type, payload: { schemaVersion: 1, roomId: identity.roomId, rootTaskId: identity.rootTaskId, runId: identity.runId,
        invocationId: identity.invocationId, workPackageId: identity.workPackageId, occurredAt: new Date().toISOString(), ...payload } });
    recordServiceEvent(committed);
  }
}
