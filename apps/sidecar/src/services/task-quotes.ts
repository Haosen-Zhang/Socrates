import { commandRoom } from "./command-room";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { LEADER_LIMITS, MAX_AUTOMATIC_OUTPUT_TOKENS, atomic, isRoutingEnabled, resolveRoomCommand, requestCostUpperBound, type RoomCommandInput } from "@socrates/core";
import type { SessionStore } from "../store/session-store";
import { PricingStore } from "./pricing-store";
import type { RoutePolicyService, RoutePreview } from "./route-policy";
import { modelProtocol } from "./model-invocation-broker";

export type QuoteInput = Omit<RoomCommandInput, "clientRequestId" | "quoteId">;
export interface TaskQuote {
  id: string; roomId: string; inputHash: string; expiresAt: string; createdAt: string; kind: string;
  heuristic: true; lowAtomic: string | null; highAtomic: string | null; currency: "USD";
  stages: Array<{ stage: string; lowAtomic: string | null; highAtomic: string | null; assumptions: string[] }>;
  unknowns: string[]; maxOutputTokens: number; priceSnapshotIds: string[];
  route?: RoutePreview;
  inputBytes: number; inputTokensEstimate: number; policyVersion: string;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** No model calls or network: quotes are heuristic, bound to actual room/configuration revisions. */
export class TaskQuoteService {
  private readonly prices: PricingStore;
  constructor(private readonly db: Database, private readonly sessions: SessionStore, private readonly routing?: RoutePolicyService) { this.prices = new PricingStore(db); }

  quote(input: QuoteInput): TaskQuote {
    const binding = this.binding(input);
    const { room, resolved, providers, snapshots, inputBytes, maxOutputTokens, route } = binding;
    const unknowns: string[] = [];
    if ([...snapshots.values()].some(price => price?.estimateReason)) unknowns.push("prices_are_reference_estimates");
    const stage = (name: string, ids: string[], lowCalls: number, highCalls: number, assumptions: string[]) => {
      let low = 0n, high = 0n, known = true;
      for (const id of ids) {
        const snapshot = snapshots.get(id);
        const price = snapshot ?? null;
        const lower = requestCostUpperBound(price, Math.max(1, Math.ceil(inputBytes / 4)), Math.max(1, Math.floor(maxOutputTokens / 4)));
        const upper = requestCostUpperBound(price, inputBytes + 4_096, maxOutputTokens);
        if (!lower || !upper || lower.currency !== "USD" || upper.currency !== "USD") { known = false; unknowns.push(`price_unknown_or_non_usd:${id}`); }
        else { low += BigInt(lower.atomic) * BigInt(lowCalls); high += BigInt(upper.atomic) * BigInt(highCalls); }
      }
      return { stage: name, lowAtomic: known ? low.toString() : null, highAtomic: known ? high.toString() : null, assumptions };
    };
    const stages: TaskQuote["stages"] = [];
    if (route) {
      stages.push(...(route.selected?.stages ?? [{stage:"execution",lowAtomic:null,highAtomic:null,assumptions:["routing_no_feasible_candidate"]}]));
      unknowns.push("routing_rules_only_no_measured_success_probability");
    } else if (resolved.kind === "team") {
      const manager = room.collaboration.assignment.coordinatorAgentId ?? room.primaryAgentId;
      const rounds = room.collaboration.discussion.enabled ? room.collaboration.discussion.maxRounds : 0;
      stages.push(stage("leader_evaluation", [manager], 0, LEADER_LIMITS.maxEvaluations, [`At most ${LEADER_LIMITS.maxEvaluations} evaluations per WorkItem, ${LEADER_LIMITS.maxOutputTokens} output tokens per evaluation; ${LEADER_LIMITS.maxDelegations} approved-package delegation rounds; shares the execution budget`]));
      stages.push(stage("planning", [manager], 1, 2, ["Manager 规划 1 次；包含最多一次 JSON 修复"]));
      if (rounds) stages.push(stage("discussion", providers.map(p => p.agentId), rounds, rounds, [`${rounds} 轮讨论，重复上下文按每位成员计入`]));
      stages.push(stage("execution", providers.map(p => p.agentId), 1, 8, ["启发式：每位成员 1–8 次采样；工作包数量以审批后的计划为准"]));
      stages.push(stage("review", providers.map(p => p.agentId), 0, 2, ["预留计划/工作包审核和一次返工；仅在实际配置时消费"]));
    } else if (resolved.kind === "discussion") {
      const rounds = room.collaboration.discussion.enabled ? room.collaboration.discussion.maxRounds : 1;
      stages.push(stage("discussion", resolved.agentIds, rounds, rounds, [`${rounds} 轮，公开历史重复发送按成员分别计算`]));
      const summarizer = room.collaboration.discussion.summaryAgentId;
      if (summarizer && resolved.agentIds.includes(summarizer)) stages.push(stage("summary", [summarizer], 1, 1, ["配置的总结成员单独计费"]));
    } else stages.push(stage("execution", resolved.agentIds, 1, room.kind === "chat" ? 1 : 8, ["UTF-8 字节启发式，包含公开历史、角色提示与所选附件；工具 schema/后续结果另有不确定性"]));
    if (!route) stages.push(stage("retry_allowance", providers.map(p => p.agentId), 0, 4, ["每次采样最多 5 个可观测尝试；未知结果不会自动退款，此处为启发式余量"]));
    stages.push({ stage: "paid_tools", lowAtomic: "0", highAtomic: "0", assumptions: ["本地工具无模型收费；外部 MCP/其他付费工具未定价，预算模式下会拒绝执行"] });
    const total = (key: "lowAtomic" | "highAtomic") => stages.every(s => s[key] !== null) ? stages.reduce((sum, s) => sum + BigInt(s[key]!), 0n).toString() : null;
    if (input.attachmentIds?.length || input.workspaceRefIds?.length || input.mentions.some(m => m.type === "file")) unknowns.push("selected_files_and_multimodal_content_may_change_usage");
    unknowns.push("heuristic_not_statistical_confidence_interval", "future_tool_results_and_rework_unknown");
    const now = new Date();
    const quote: TaskQuote = { id: crypto.randomUUID(), roomId: room.id, inputHash: binding.hash,
      createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(), kind: resolved.kind,
      heuristic: true, lowAtomic: total("lowAtomic"), highAtomic: total("highAtomic"), currency: "USD", stages,
      unknowns: [...new Set(unknowns)], maxOutputTokens, priceSnapshotIds: [...new Set([...snapshots.values()].flatMap(s => s ? [s.id] : []))],
      ...(route ? { route } : {}),
      inputBytes, inputTokensEstimate: Math.ceil(inputBytes / 3), policyVersion: route?.policyVersion ?? "local_heuristic/1" };
    this.db.query("INSERT INTO cost_quotes(id,room_id,input_hash,quote_json,created_at,expires_at) VALUES (?,?,?,?,?,?)")
      .run(quote.id, room.id, quote.inputHash, JSON.stringify(quote), quote.createdAt, quote.expiresAt);
    return quote;
  }
  get(id: string): TaskQuote | null {
    const row = this.db.query<{ quote_json: string }, [string]>("SELECT quote_json FROM cost_quotes WHERE id=?").get(id);
    return row ? JSON.parse(row.quote_json) as TaskQuote : null;
  }
  validate(input: RoomCommandInput): TaskQuote | null {
    if (!input.quoteId) { if (input.budget) throw new Error("quote_required_for_budget"); return null; }
    const quote = this.get(input.quoteId);
    if (!quote || quote.roomId !== input.roomId || Date.parse(quote.expiresAt) <= Date.now() || quote.inputHash !== this.binding(input).hash) throw new Error("quote_stale");
    return quote;
  }
  private binding(input: QuoteInput) {
    if (!input.content?.trim() || !Array.isArray(input.mentions)) throw new Error("quote_content_required");
    const room = this.sessions.get(input.roomId);
    if (!room || room.archived) throw new Error("room_not_found");
    const maxOutputTokens = input.maxOutputTokens ?? MAX_AUTOMATIC_OUTPUT_TOKENS;
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32_768) throw new Error("invalid_output_cap");
    if (input.budget) {
      if (!["strict_admission", "soft_limit", "tracking_only"].includes(input.budget.mode)) throw new Error("invalid_budget_mode");
      atomic(input.budget.limitAtomic);
    }
    let resolved = resolveRoomCommand(commandRoom(this.db,room), input);
    let route: RoutePreview | undefined;
    if (isRoutingEnabled(room,input) && resolved.kind !== "discussion") {
      if (!this.routing) throw new Error("routing_runtime_unavailable");
      route=this.routing.preview(input);
      if(route.selected)resolved=route.selected.resolved;
    }
    const members = route ? room.agents.filter(a=>route!.allowedAgentIds.includes(a.agentId)) : resolved.kind === "team" ? room.agents : room.agents.filter(a => resolved.agentIds.includes(a.agentId));
    const providers = members.map(member => {
      const id = String(member.snapshot.providerId ?? "");
      const provider = this.db.query<{ type: "anthropic" | "openai_compatible"; base_url: string; enabled: number }, [string]>("SELECT type,base_url,enabled FROM providers WHERE id=?").get(id);
      return { agentId: member.agentId, member, provider, id };
    });
    const snapshots = new Map(providers.map(p => [p.agentId, p.provider?.enabled ? this.prices.resolveAutomatic({ providerConnectionId: p.id,
      modelId: String(p.member.snapshot.modelId ?? ""), protocol: modelProtocol(p.provider.type, p.provider.base_url), baseUrl: p.provider.base_url }) : null]));
    const refs = [...new Set([...(input.workspaceRefIds ?? []), ...input.mentions.flatMap(m => m.type === "file" ? [m.refId] : [])])].map(id => {
      const ref = this.db.query<{ workspace_id: string; snapshot_hash: string; snapshot_size: number }, [string]>("SELECT workspace_id,snapshot_hash,snapshot_size FROM workspace_refs WHERE id=?").get(id);
      if (!ref || ref.workspace_id !== room.workspaceId) throw new Error("workspace_reference_out_of_scope");
      return { id, ...ref };
    });
    const attachments = (input.attachmentIds ?? []).map(id => {
      const attachment = this.db.query<{ sha256: string; byte_size: number; media_type: string }, [string]>("SELECT sha256,byte_size,media_type FROM attachments WHERE id=?").get(id);
      if (!attachment) throw new Error("attachment_not_found");
      if (room.kind === "chat" || !this.db.query("SELECT attachment_id FROM attachment_sources WHERE attachment_id=? AND workspace_id=?").get(id, room.workspaceId)) throw new Error("attachment_out_of_scope");
      return { id, ...attachment };
    });
    const messages = this.sessions.listMessages(room.id);
    const basis = { routingBinding: route?.bindingHash ?? null, verificationPlanId:input.verificationPlanId ?? null, routingCandidateId:input.routingCandidateId ?? null, roomId: input.roomId, content: input.content, mentions: input.mentions, intent: input.intent,
      maxOutputTokens, budget: input.budget ?? null, members, collaboration: room.collaboration, kind: room.kind,
      primaryAgentId: room.primaryAgentId, providers: providers.map(p => ({ id: p.id, provider: p.provider })),
      prices: [...snapshots.values()].map(s => s?.id ?? null), refs, attachments,
      history: messages.map(m => ({ id: m.id, content: m.content, status: m.status })) };
    const inputBytes = new TextEncoder().encode(JSON.stringify({ request: input.content, messages, members })).byteLength
      + attachments.reduce((n, a) => n + a.byte_size, 0) + refs.reduce((n, r) => n + (r.snapshot_size ?? 0), 0);
    return { room, resolved, route, providers, snapshots, inputBytes, maxOutputTokens, hash: hash(basis) };
  }
}
