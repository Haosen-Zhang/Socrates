import type { Database } from "bun:sqlite";
import {
  atomic, money, priceUsage, type BudgetAccount, type BudgetMode, type BudgetSummary, type CostSummary,
  type InvocationIdentity, type InvocationRecord, type Money, type TokenUsage,
} from "@socrates/core";
import { EventStore } from "../store/event-store";
import { PricingStore } from "./pricing-store";

interface InvocationRow {
  id: string; identity_json: string; price_snapshot_id: string | null; state: InvocationRecord["state"]; status: InvocationRecord["status"];
  usage_json: string | null; lines_json: string; unknown_json: string; currency: string | null; amount_atomic: string | null;
  request_id: string | null; finish_reason: string | null; outcome: string | null; adapter_version: string; created_at: string; updated_at: string;
}
interface BudgetRow { root_task_id: string; room_id: string; mode: BudgetMode; limit_atomic: string; parent_id: string | null; revision: number; blocked_reason: string | null; blocked_json: string | null }
interface ReservationRow { invocation_id: string; root_task_id: string; amount_atomic: string; state: string }
type Filter = { roomId?: string; rootTaskId?: string; agentId?: string; since?: string; until?: string };
type Finish = { usage?: TokenUsage; requestId?: string; finishReason?: string; outcome?: string };
function minimalUsage(raw: TokenUsage): TokenUsage {
  const result: TokenUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    if (typeof raw[key] === "number") result[key] = raw[key];
  }
  if (Array.isArray(raw.unsupportedBillingDimensions)) result.unsupportedBillingDimensions = raw.unsupportedBillingDimensions
    .filter(value => typeof value === "string" && /^[a-zA-Z0-9_:.=-]{1,150}$/.test(value)).slice(0, 30);
  return result;
}
function fromRow(row: InvocationRow): InvocationRecord {
  return { ...JSON.parse(row.identity_json) as InvocationIdentity, priceSnapshotId: row.price_snapshot_id, state: row.state, status: row.status,
    usage: row.usage_json ? JSON.parse(row.usage_json) as TokenUsage : null, lineItems: JSON.parse(row.lines_json), unknownItems: JSON.parse(row.unknown_json),
    amount: row.currency && row.amount_atomic !== null ? money(row.amount_atomic, row.currency) : null,
    requestId: row.request_id, finishReason: row.finish_reason, outcome: row.outcome, adapterVersion: row.adapter_version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function account(row: BudgetRow): BudgetAccount { return { rootTaskId: row.root_task_id, roomId: row.room_id, mode: row.mode, limitAtomic: row.limit_atomic, parentId: row.parent_id, revision: row.revision }; }
function descendants(db: Database, rootTaskId: string): string[] {
  return db.query<{ id: string }, [string]>(`WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT a.root_task_id FROM cost_budget_accounts a JOIN tree ON a.parent_id=tree.id) SELECT id FROM tree`).all(rootTaskId).map(row => row.id);
}
function totals(records: InvocationRecord[], adjustments: Array<{ amount_atomic: string; currency: string }>): Money[] {
  const amounts = new Map<string, bigint>();
  for (const record of records) if (record.amount) amounts.set(record.amount.currency, (amounts.get(record.amount.currency) ?? 0n) + BigInt(record.amount.atomic));
  for (const adjustment of adjustments) amounts.set(adjustment.currency, (amounts.get(adjustment.currency) ?? 0n) + BigInt(adjustment.amount_atomic));
  return [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => money(amount, currency));
}
function unknown(record: InvocationRecord): boolean { return !record.reconciliation && (record.state === "sent" || record.state === "outcome_unknown" || record.state === "finished" && !["priced", "estimated"].includes(record.status)); }
function knownTotals(records: InvocationRecord[], adjustments: Array<{ amount_atomic: string; currency: string }>): Money[] {
  return totals(records.filter(record => record.status !== "estimated" || record.reconciliation), adjustments);
}
function estimatedTotals(records: InvocationRecord[]): Money[] {
  return totals(records.filter(record => !record.reconciliation && (record.status === "estimated" || record.referenceEstimate))
    .map(record => ({ ...record, amount: record.referenceEstimate?.amount ?? record.amount })), []);
}
function categories(records: InvocationRecord[]) {
  const active = records.filter(record => !record.reconciliation);
  return { estimatedCount: active.filter(record => record.status === "estimated" || record.referenceEstimate).length,
    outcomeUnknownCount: active.filter(record => record.state === "sent" || record.state === "outcome_unknown").length,
    unpricedCount: active.filter(record => record.state === "finished" && record.status === "unpriced" && !record.referenceEstimate).length,
    partialCount: active.filter(record => record.state === "finished" && record.status === "partially_priced").length };
}
function event(db: Database, roomId: string, rootTaskId: string, type: string, id: string, payload: Record<string, unknown>): void {
  // Room deletion may remove its reversible event projection. The accounting
  // fact and any later reconciliation must remain valid independently.
  if (!db.query("SELECT id FROM sessions WHERE id=?").get(roomId)) return;
  new EventStore(db).appendInTransaction({ eventId: `${type}:${id}`, sessionId: roomId, taskId: rootTaskId, type,
    payload: { schemaVersion: 1, roomId, rootTaskId, ...payload } });
}

/** Sole authority for physical requests. It stores usage-only evidence, never prompts or secrets. */
export class CostLedger {
  private readonly pricing: PricingStore;
  constructor(private readonly db: Database, pricing?: PricingStore) { this.pricing = pricing ?? new PricingStore(db); }
  begin(identity: InvocationIdentity, priceSnapshotId: string | null): InvocationRecord {
    if (!identity.invocationId || !identity.roomId || !identity.rootTaskId || !identity.runId || !identity.agentId || !Number.isSafeInteger(identity.attemptNo) || identity.attemptNo < 1) throw new Error("invalid_invocation_identity");
    const existing = this.get(identity.invocationId);
    if (existing) {
      const { invocationId: _id, ...expected } = identity, { invocationId: _oldId, ...prior } = JSON.parse(this.row(identity.invocationId)!.identity_json) as InvocationIdentity;
      if (JSON.stringify(expected) !== JSON.stringify(prior) || existing.priceSnapshotId !== priceSnapshotId) throw new Error("invocation_identity_conflict");
      return existing;
    }
    if (priceSnapshotId && !this.pricing.get(priceSnapshotId)) throw new Error("price_snapshot_not_found");
    const now = new Date().toISOString();
    this.db.query(`INSERT INTO cost_invocations(id,logical_step_id,attempt_no,room_id,root_task_id,run_id,agent_id,identity_json,price_snapshot_id,state,status,adapter_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,'created','unpriced','text_tokens/1',?,?)`).run(identity.invocationId, identity.logicalStepId, identity.attemptNo, identity.roomId, identity.rootTaskId, identity.runId, identity.agentId, JSON.stringify(identity), priceSnapshotId, now, now);
    return this.get(identity.invocationId)!;
  }
  private row(id: string): InvocationRow | null { return this.db.query<InvocationRow, [string]>("SELECT * FROM cost_invocations WHERE id=?").get(id); }
  private project(row: InvocationRow): InvocationRecord {
    const record = fromRow(row), resolved = this.db.query<{ actual_total_atomic: string; currency: string; request_id: string; reason: string }, [string]>("SELECT actual_total_atomic,currency,request_id,reason FROM cost_adjustments WHERE invocation_id=? AND actual_total_atomic IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(record.invocationId);
    if (resolved) return { ...record, reconciliation: { amount: money(resolved.actual_total_atomic, resolved.currency), requestId: resolved.request_id, reason: resolved.reason } };
    if (record.state === "finished" && record.status === "unpriced" && record.usage && record.unknownItems.every(item => item === "price_unknown")) {
      const provider = this.db.query<{ type: string; base_url: string }, [string]>("SELECT type,base_url FROM providers WHERE id=?").get(record.providerConnectionId);
      if (provider) try {
        const url = new URL(provider.base_url);
        const protocol = provider.type === "anthropic" ? "anthropic_messages" : url.origin === "https://api.openai.com" && url.pathname.replace(/\/$/, "") === "/v1" ? "openai_responses" : "openai_chat_completions";
        const price = this.pricing.resolveAutomatic({ providerConnectionId: record.providerConnectionId, modelId: record.modelId, baseUrl: provider.base_url, protocol });
        const estimate = priceUsage(record.usage, price);
        if (estimate.amount && ["priced", "estimated"].includes(estimate.status)) return { ...record, referenceEstimate: { amount: estimate.amount, priceSnapshotId: price.id, source: price.source, reason: "historical_current_reference" } };
      } catch { /* Historical facts remain intact if no current reference is usable. */ }
    }
    return record;
  }
  get(id: string): InvocationRecord | null { const row = this.row(id); return row ? this.project(row) : null; }
  list(filter: Filter = {}): InvocationRecord[] {
    const where:string[]=[],args:string[]=[];
    for(const [column,value,operator] of [['room_id',filter.roomId,'='],['agent_id',filter.agentId,'='],['created_at',filter.since,'>='],['created_at',filter.until,'<=']] as const)if(value){where.push(`${column}${operator}?`);args.push(value);}
    const rows=this.db.query<InvocationRow,string[]>(`SELECT * FROM cost_invocations${where.length?' WHERE '+where.join(' AND '):''} ORDER BY rowid`).all(...args);
    const tasks = filter.rootTaskId ? new Set(descendants(this.db, filter.rootTaskId)) : null;
    return rows.map(row=>this.project(row)).filter(record=>!tasks||tasks.has(record.rootTaskId));
  }
  markSent(id: string, requestId?: string): void {
    this.db.transaction(() => {
      const record = this.get(id); if (!record) throw new Error("invocation_not_found");
      if (record.state !== "created") throw new Error("invocation_already_dispatched");
      const now = new Date().toISOString();
      this.db.query("UPDATE cost_invocations SET state='sent',request_id=COALESCE(?,request_id),updated_at=? WHERE id=?").run(requestId ?? null, now, id);
      this.db.query("UPDATE cost_reservations SET state='sent',updated_at=? WHERE invocation_id=? AND state='reserved'").run(now, id);
    }).immediate();
  }
  finish(id: string, input: Finish): InvocationRecord {
    if (input.outcome === "not_sent") { this.releaseUnsent(id); return this.get(id)!; }
    return this.db.transaction(() => {
      const record = this.get(id); if (!record) throw new Error("invocation_not_found");
      if (record.state === "finished" || record.state === "not_sent" || record.reconciliation) return record;
      if (record.state !== "sent" && record.state !== "outcome_unknown") throw new Error("invocation_not_sent");
      const usage = input.usage ? minimalUsage(input.usage) : undefined;
      const snapshot = record.priceSnapshotId ? this.pricing.get(record.priceSnapshotId) : null;
      const invalidInterval = snapshot && (record.createdAt < snapshot.validFrom ? "price_snapshot_not_yet_valid" : snapshot.validUntil && record.createdAt >= snapshot.validUntil ? "price_snapshot_expired" : null);
      const priced = priceUsage(usage, invalidInterval ? null : snapshot), now = new Date().toISOString();
      if (invalidInterval) priced.unknownItems = [invalidInterval, ...priced.unknownItems.filter(item => item !== "price_unknown")];
      const state = input.usage ? "finished" : "outcome_unknown";
      this.db.query(`UPDATE cost_invocations SET state=?,status=?,usage_json=?,lines_json=?,unknown_json=?,currency=?,amount_atomic=?,request_id=COALESCE(?,request_id),finish_reason=?,outcome=?,adapter_version=?,updated_at=? WHERE id=?`)
        .run(state, priced.status, usage ? JSON.stringify(usage) : null, JSON.stringify(priced.lineItems), JSON.stringify(priced.unknownItems), priced.amount?.currency ?? null, priced.amount?.atomic ?? null,
          input.requestId ?? null, input.finishReason ?? null, input.outcome ?? null, priced.adapterVersion, now, id);
      // A partially priced response does not release the unknown remainder.
      this.db.query("UPDATE cost_reservations SET state=?,updated_at=? WHERE invocation_id=? AND state IN ('reserved','sent','unknown')")
        .run(["priced", "estimated"].includes(priced.status) ? "settled" : "unknown", now, id);
      const updated = this.get(id)!;
      event(this.db, record.roomId, record.rootTaskId, ["priced", "estimated"].includes(priced.status) ? "cost.invocation_priced" : "cost.reconciliation_required", id, { invocationId: id, runId: record.runId, status: priced.status, amount: priced.amount, priceSnapshotId: record.priceSnapshotId });
      event(this.db, record.roomId, record.rootTaskId, "budget.settled", id, { invocationId: id, amount: priced.amount, unresolved: !["priced", "estimated"].includes(priced.status) });
      new BudgetLedger(this.db).detectBreach(record.rootTaskId, id, id);
      return updated;
    }).immediate();
  }
  markUnknown(id: string, requestId?: string): void {
    const record = this.get(id); if (!record) throw new Error("invocation_not_found");
    if (record.state === "created") { this.releaseUnsent(id, "confirmed_not_sent"); return; }
    if (record.state === "finished" || record.state === "not_sent") return;
    this.finish(id, { requestId, outcome: "outcome_unknown" });
  }
  releaseUnsent(id: string, reason = "confirmed_not_sent"): void {
    this.db.transaction(() => {
      const record = this.get(id); if (!record) throw new Error("invocation_not_found");
      if (record.state === "not_sent") return;
      if (record.state !== "created") throw new Error("invocation_may_have_been_sent");
      const now = new Date().toISOString();
      this.db.query("UPDATE cost_invocations SET state='not_sent',outcome=?,updated_at=? WHERE id=?").run(reason, now, id);
      this.db.query("UPDATE cost_reservations SET state='released',updated_at=? WHERE invocation_id=? AND state='reserved'").run(now, id);
    }).immediate();
  }
  adjust(id: string, input: { requestId: string; amountAtomic: string; currency: string; reason: string }): void {
    atomic(input.amountAtomic, true);
    if (!input.requestId || !input.reason || !/^[A-Z]{3,8}$/.test(input.currency)) throw new Error("invalid_cost_adjustment");
    this.db.transaction(() => {
      const invocation = this.get(id); if (!invocation) throw new Error("invocation_not_found");
      const existing = this.db.query<{ amount_atomic: string; currency: string; reason: string }, [string, string]>("SELECT amount_atomic,currency,reason FROM cost_adjustments WHERE invocation_id=? AND request_id=?").get(id, input.requestId);
      if (existing) { if (existing.amount_atomic !== input.amountAtomic || existing.currency !== input.currency || existing.reason !== input.reason) throw new Error("cost_adjustment_conflict"); return; }
      this.db.query("INSERT INTO cost_adjustments(id,invocation_id,request_id,amount_atomic,currency,reason,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), id, input.requestId, input.amountAtomic, input.currency, input.reason, new Date().toISOString());
      event(this.db, invocation.roomId, invocation.rootTaskId, "cost.adjusted", `${id}:${input.requestId}`, { invocationId: id, adjustment: { ...input } });
      new BudgetLedger(this.db).detectBreach(invocation.rootTaskId, input.requestId, id);
    }).immediate();
  }
  /** Invoice reconciliation is an additional immutable fact, not a rewrite of missing provider usage. */
  reconcile(id: string, input: { requestId: string; totalAtomic: string; currency: string; reason: string }): void {
    atomic(input.totalAtomic);
    if (!input.requestId || !input.reason || !/^[A-Z]{3,8}$/.test(input.currency)) throw new Error("invalid_cost_reconciliation");
    this.db.transaction(() => {
      const invocation = this.get(id); if (!invocation || ["created", "not_sent"].includes(invocation.state)) throw new Error("invocation_not_sent");
      // No implicit FX conversion is allowed to turn a USD reserve into a
      // settled foreign invoice and thereby release the parent's dollar cap.
      if (input.currency !== "USD" && this.db.query(`WITH RECURSIVE ancestors(root_task_id,parent_id,mode) AS (
        SELECT root_task_id,parent_id,mode FROM cost_budget_accounts WHERE root_task_id=?
        UNION SELECT a.root_task_id,a.parent_id,a.mode FROM cost_budget_accounts a JOIN ancestors p ON a.root_task_id=p.parent_id
      ) SELECT root_task_id FROM ancestors WHERE mode!='tracking_only' LIMIT 1`).get(invocation.rootTaskId)) throw new Error("cost_budget_currency_unsupported");
      if (invocation.amount && invocation.amount.currency !== input.currency) throw new Error("cost_reconciliation_currency_mismatch");
      const existing = this.db.query<{ actual_total_atomic: string | null; currency: string; reason: string }, [string, string]>("SELECT actual_total_atomic,currency,reason FROM cost_adjustments WHERE invocation_id=? AND request_id=?").get(id, input.requestId);
      if (existing) { if (existing.actual_total_atomic !== input.totalAtomic || existing.currency !== input.currency || existing.reason !== input.reason) throw new Error("cost_reconciliation_conflict"); return; }
      const current = (invocation.amount ? BigInt(invocation.amount.atomic) : 0n) + this.db.query<{ amount_atomic: string }, [string, string]>("SELECT amount_atomic FROM cost_adjustments WHERE invocation_id=? AND currency=?").all(id, input.currency).reduce((sum, row) => sum + BigInt(row.amount_atomic), 0n);
      const now = new Date().toISOString();
      this.db.query("INSERT INTO cost_adjustments(id,invocation_id,request_id,amount_atomic,currency,reason,actual_total_atomic,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), id, input.requestId, (BigInt(input.totalAtomic) - current).toString(), input.currency, input.reason, input.totalAtomic, now);
      this.db.query("UPDATE cost_reservations SET state='settled',updated_at=? WHERE invocation_id=?").run(now, id);
      event(this.db, invocation.roomId, invocation.rootTaskId, "cost.reconciled", `${id}:${input.requestId}`, { invocationId: id, requestId: input.requestId, amount: money(input.totalAtomic, input.currency) });
      new BudgetLedger(this.db).detectBreach(invocation.rootTaskId, input.requestId, id);
    }).immediate();
  }
  summary(filter: Filter = {}): CostSummary {
    const records = this.list(filter).filter(record => !["created", "not_sent"].includes(record.state));
    const adjustments = records.flatMap(record => this.db.query<{ amount_atomic: string; currency: string }, [string]>("SELECT amount_atomic,currency FROM cost_adjustments WHERE invocation_id=?").all(record.invocationId));
    const usage: TokenUsage = {};
    for (const key of ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
      const values = records.map(record => record.usage?.[key]).filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
      if (values.length) usage[key] = values.reduce((sum, value) => sum + value, 0);
    }
    const dimensions = [...new Set(records.flatMap(record => record.usage?.unsupportedBillingDimensions ?? []))];
    if (dimensions.length) usage.unsupportedBillingDimensions = dimensions;
    const byAgent = [...new Set(records.map(record => record.agentId))].map(agentId => {
      const member = records.filter(record => record.agentId === agentId), memberAdjustments = member.flatMap(record => this.db.query<{ amount_atomic: string; currency: string }, [string]>("SELECT amount_atomic,currency FROM cost_adjustments WHERE invocation_id=?").all(record.invocationId));
      return { agentId, invocations: member.length, unknownCount: member.filter(unknown).length, totals: knownTotals(member, memberAdjustments), estimatedTotals: estimatedTotals(member), ...categories(member) };
    });
    const historical = this.db.query<{ session_id: string | null; room_id: string | null; task_id: string | null }, []>("SELECT session_id,room_id,task_id FROM cost_legacy_usage").all();
    const tasks = filter.rootTaskId ? new Set(descendants(this.db, filter.rootTaskId)) : null;
    const historicalUnknownCount = filter.agentId || filter.since || filter.until ? 0 : historical.filter(row => (!filter.roomId || row.session_id === filter.roomId || row.room_id === filter.roomId) && (!tasks || !!row.task_id && tasks.has(row.task_id))).length;
    return { invocations: records.length, unknownCount: records.filter(unknown).length, totals: knownTotals(records, adjustments), estimatedTotals: estimatedTotals(records), ...categories(records), byAgent, usage, historicalUnknownCount };
  }
}

/** Atomic admission across a root task and any experiment/trial ancestor accounts. */
export class BudgetLedger {
  constructor(private readonly db: Database) {}
  private row(rootTaskId: string): BudgetRow | null { return this.db.query<BudgetRow, [string]>("SELECT * FROM cost_budget_accounts WHERE root_task_id=?").get(rootTaskId); }
  get(rootTaskId: string): BudgetAccount | null { const row = this.row(rootTaskId); return row ? account(row) : null; }
  create(input: { rootTaskId: string; roomId: string; mode: BudgetMode; limitAtomic: string; parentId?: string | null }): BudgetAccount {
    atomic(input.limitAtomic);
    if (!input.rootTaskId || !input.roomId || !["strict_admission", "soft_limit", "tracking_only"].includes(input.mode)) throw new Error("invalid_cost_budget");
    return this.db.transaction(() => {
      const existing = this.get(input.rootTaskId);
      if (existing) { if (existing.roomId !== input.roomId || existing.mode !== input.mode || existing.limitAtomic !== input.limitAtomic || existing.parentId !== (input.parentId ?? null)) throw new Error("cost_budget_identity_conflict"); return existing; }
      if (input.parentId) { const parent = this.get(input.parentId); if (!parent || parent.roomId !== input.roomId) throw new Error("cost_budget_parent_invalid"); }
      const now = new Date().toISOString();
      this.db.query("INSERT INTO cost_budget_accounts(root_task_id,room_id,mode,limit_atomic,parent_id,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)")
        .run(input.rootTaskId, input.roomId, input.mode, input.limitAtomic, input.parentId ?? null, now, now);
      return this.get(input.rootTaskId)!;
    }).immediate();
  }
  summary(rootTaskId: string): BudgetSummary {
    const row = this.row(rootTaskId); if (!row) throw new Error("cost_budget_not_found");
    const tasks = new Set(descendants(this.db, rootTaskId)), cost = new CostLedger(this.db).summary({ rootTaskId });
    const settled = BigInt(cost.totals.find(total => total.currency === "USD")?.atomic ?? "0");
    const estimated = new CostLedger(this.db).list({ rootTaskId }).filter(record => record.status === "estimated" && !record.reconciliation && record.amount?.currency === "USD")
      .reduce((sum, record) => sum + BigInt(record.amount!.atomic), 0n);
    let reserved = 0n, unresolved = 0n;
    for (const reserve of this.db.query<ReservationRow, []>("SELECT * FROM cost_reservations WHERE state IN ('reserved','sent','unknown')").all()) {
      if (!tasks.has(reserve.root_task_id)) continue;
      if (reserve.state === "unknown") {
        // Known partial line items are already settled. Retain only the
        // remaining reserved exposure; never count one reserve twice.
        const invocation = new CostLedger(this.db).get(reserve.invocation_id);
        const known = invocation?.amount?.currency === "USD" ? BigInt(invocation.amount.atomic) : 0n;
        unresolved += BigInt(reserve.amount_atomic) > known ? BigInt(reserve.amount_atomic) - known : 0n;
      } else reserved += BigInt(reserve.amount_atomic);
    }
    return { ...account(row), settledKnownAtomic: settled.toString(), estimatedAtomic: estimated.toString(), activeReservationsAtomic: reserved.toString(), unresolvedExposureAtomic: unresolved.toString(),
      availableAtomic: (BigInt(row.limit_atomic) - settled - estimated - reserved - unresolved).toString(), unknownCount: cost.unknownCount, breached: settled + estimated > BigInt(row.limit_atomic) || row.blocked_reason === "cost_budget_breached", blockedReason: row.blocked_reason };
  }
  private ancestors(rootTaskId: string): BudgetAccount[] {
    const result: BudgetAccount[] = [], seen = new Set<string>(); let id: string | null = rootTaskId;
    while (id) { if (seen.has(id)) throw new Error("cost_budget_parent_cycle"); seen.add(id); const item = this.get(id); if (!item) throw new Error("cost_budget_not_found"); result.push(item); id = item.parentId; }
    return result;
  }
  reserve(invocationId: string, rootTaskId: string, amountAtomic: string, options: { strictEligible: boolean; reason?: string }): void {
    const amount = atomic(amountAtomic);
    let failure: string | null = null;
    this.db.transaction(() => {
      const existing = this.db.query<ReservationRow, [string]>("SELECT * FROM cost_reservations WHERE invocation_id=?").get(invocationId);
      if (existing) { if (existing.root_task_id !== rootTaskId || existing.amount_atomic !== amountAtomic) throw new Error("cost_budget_reservation_conflict"); return; }
      const ledger = new CostLedger(this.db), invocation = ledger.get(invocationId); if (!invocation || invocation.rootTaskId !== rootTaskId || invocation.state !== "created") throw new Error("cost_budget_invocation_invalid");
      const accounts = this.ancestors(rootTaskId), currency = invocation.priceSnapshotId ? new PricingStore(this.db).get(invocation.priceSnapshotId)?.currency : null;
      for (const item of accounts) {
        if (item.mode === "tracking_only") continue;
        const summary = this.summary(item.rootTaskId);
        if (item.mode === "strict_admission" && !options.strictEligible) failure = options.reason ?? "cost_budget_unbounded_request";
        else if (currency && currency !== "USD") failure = "cost_budget_currency_unsupported";
        else if (!currency) failure = "cost_budget_unknown_price";
        else if (summary.breached) failure = "cost_budget_breached";
        else if (amount > BigInt(summary.availableAtomic)) failure = "cost_budget_insufficient";
        if (failure) { this.blockInTransaction(item.rootTaskId, failure, { invocationId, requiredAtomic: amountAtomic, availableAtomic: summary.availableAtomic }); break; }
      }
      if (failure) {
        ledger.releaseUnsent(invocationId, failure);
        return;
      }
      const now = new Date().toISOString();
      this.db.query("INSERT INTO cost_reservations(invocation_id,root_task_id,amount_atomic,state,created_at,updated_at) VALUES (?,?,?,'reserved',?,?)").run(invocationId, rootTaskId, amountAtomic, now, now);
      this.db.query("UPDATE cost_budget_accounts SET blocked_reason=NULL,blocked_json=NULL,updated_at=? WHERE root_task_id=?").run(now, rootTaskId);
      event(this.db, invocation.roomId, rootTaskId, "budget.reserved", invocationId, { invocationId, amountAtomic });
    }).immediate();
    if (failure) throw new Error(failure);
  }
  block(rootTaskId: string, reason: string, details: Record<string, unknown> = {}): void { this.db.transaction(() => this.blockInTransaction(rootTaskId, reason, details)).immediate(); }
  private blockInTransaction(rootTaskId: string, reason: string, details: Record<string, unknown>): void {
    const row = this.row(rootTaskId); if (!row) throw new Error("cost_budget_not_found");
    this.db.query("UPDATE cost_budget_accounts SET blocked_reason=?,blocked_json=?,updated_at=? WHERE root_task_id=?").run(reason, JSON.stringify(details), new Date().toISOString(), rootTaskId);
    event(this.db, row.room_id, rootTaskId, "budget.blocked", `${rootTaskId}:${crypto.randomUUID()}`, { reason, ...details });
  }
  latestBlocked(rootTaskId: string): { reason: string; details: Record<string, unknown> } | null { const row = this.row(rootTaskId); return row?.blocked_reason ? { reason: row.blocked_reason, details: row.blocked_json ? JSON.parse(row.blocked_json) : {} } : null; }
  increase(rootTaskId: string, input: { requestId: string; expectedRevision: number; amountAtomic: string }): BudgetAccount {
    if (atomic(input.amountAtomic) <= 0n || !input.requestId || !Number.isSafeInteger(input.expectedRevision)) throw new Error("invalid_cost_budget_increase");
    return this.db.transaction(() => {
      const existing = this.db.query<{ amount_atomic: string; expected_revision: number; result_json: string }, [string, string]>("SELECT * FROM cost_budget_increases WHERE root_task_id=? AND request_id=?").get(rootTaskId, input.requestId);
      if (existing) { if (existing.amount_atomic !== input.amountAtomic || existing.expected_revision !== input.expectedRevision) throw new Error("cost_budget_increase_conflict"); return JSON.parse(existing.result_json) as BudgetAccount; }
      const row = this.row(rootTaskId); if (!row) throw new Error("cost_budget_not_found");
      if (row.revision !== input.expectedRevision) throw new Error("cost_budget_revision_conflict");
      const now = new Date().toISOString(), limit = (BigInt(row.limit_atomic) + BigInt(input.amountAtomic)).toString();
      this.db.query("UPDATE cost_budget_accounts SET limit_atomic=?,revision=revision+1,blocked_reason=NULL,blocked_json=NULL,updated_at=? WHERE root_task_id=?").run(limit, now, rootTaskId);
      const result = this.get(rootTaskId)!;
      this.db.query("INSERT INTO cost_budget_increases(root_task_id,request_id,expected_revision,amount_atomic,result_json,created_at) VALUES (?,?,?,?,?,?)")
        .run(rootTaskId, input.requestId, input.expectedRevision, input.amountAtomic, JSON.stringify(result), now);
      event(this.db, row.room_id, rootTaskId, "budget.increased", `${rootTaskId}:${input.requestId}`, { requestId: input.requestId, amountAtomic: input.amountAtomic, revision: result.revision, limitAtomic: result.limitAtomic });
      return result;
    }).immediate();
  }
  detectBreach(rootTaskId: string, evidenceId: string, invocationId?: string): void {
    if (!this.get(rootTaskId)) return;
    const reservation = invocationId ? this.db.query<ReservationRow, [string]>("SELECT * FROM cost_reservations WHERE invocation_id=?").get(invocationId) : null;
    const invocation = invocationId ? new CostLedger(this.db).get(invocationId) : null;
    const invoiceAdjustments = invocationId ? this.db.query<{ amount_atomic: string }, [string]>("SELECT amount_atomic FROM cost_adjustments WHERE invocation_id=? AND currency='USD'").all(invocationId) : [];
    const invocationKnown = (invocation?.amount?.currency === "USD" ? BigInt(invocation.amount.atomic) : 0n) + invoiceAdjustments.reduce((sum, adjustment) => sum + BigInt(adjustment.amount_atomic), 0n);
    const reservationExceeded = !!reservation && invocationKnown > BigInt(reservation.amount_atomic);
    for (const item of this.ancestors(rootTaskId)) {
      const summary = this.summary(item.rootTaskId);
      if ((summary.breached || reservationExceeded) && item.mode !== "tracking_only") {
        const details = { evidenceId, invocationId, settledKnownAtomic: summary.settledKnownAtomic, limitAtomic: summary.limitAtomic,
          ...(reservationExceeded ? { requestActualAtomic: invocationKnown.toString(), reservedAtomic: reservation!.amount_atomic, reason: "request_exceeded_reservation" } : {}) };
        this.blockInTransaction(item.rootTaskId, "cost_budget_breached", details);
        event(this.db, item.roomId, item.rootTaskId, "budget.breached", `${item.rootTaskId}:${evidenceId}`, details);
      }
    }
  }
  recoverInterrupted(): void {
    this.db.transaction(() => {
      const ledger = new CostLedger(this.db);
      for (const row of this.db.query<{ id: string; state: string }, []>("SELECT id,state FROM cost_invocations WHERE state IN ('created','sent')").all()) {
        if (row.state === "created") ledger.releaseUnsent(row.id, "recovered_confirmed_not_sent"); else ledger.markUnknown(row.id);
      }
    }).immediate();
  }
}
