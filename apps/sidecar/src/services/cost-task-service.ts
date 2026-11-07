import type { Database } from "bun:sqlite";
import { MAX_AUTOMATIC_OUTPUT_TOKENS, requestCostUpperBound, type RoomCommandInput, type RouteDecision } from "@socrates/core";
import type { RoomCommandService } from "./room-command-service";
import { BudgetLedger, CostLedger } from "./cost-ledger";
import { EventStore } from "../store/event-store";
import { SessionStore } from "../store/session-store";
import { TaskQuoteService } from "./task-quotes";
import type { RunSupervisor } from "../runtime/run-supervisor";
import type { SingleAgentRunner } from "../runtime/single-agent-runner";
import type { MultiTaskStore } from "../multi-agent/task-store";
import type { MultiAgentCoordinator } from "../multi-agent/coordinator";
import type { TeamRunner } from "../multi-agent/team-runner";
import type { ExecutionRunner } from "../runtime/execution-runner";
import type { RoutePolicyService } from "./route-policy";
import type { AdaptiveWorkflowService } from "./adaptive-workflow";
import { assertFrozenRouteAvailable, assertRoutingCallSlot } from "./routing-admission";

interface RoutingResumeDependencies {
  routing: Pick<RoutePolicyService, "get">;
  adaptive: Pick<AdaptiveWorkflowService, "get" | "resume">;
}

/** Resume reuses original room/task and durable tool facts, never submits a new task. */
export class CostTaskService {
  private readonly pending = new Map<string, { maxOutputTokens?: number; operation: Promise<unknown> }>();
  constructor(private readonly db: Database, private readonly commands: RoomCommandService,
    private readonly supervisor: RunSupervisor, private readonly runner: SingleAgentRunner,
    private readonly tasks: MultiTaskStore, private readonly coordinator: MultiAgentCoordinator,
    private readonly team: TeamRunner, private readonly execution: ExecutionRunner,
    private readonly routing?: RoutingResumeDependencies) {
    db.query("UPDATE cost_actions SET state='interrupted' WHERE state='started'").run();
  }
  resume(rootTaskId: string, input: { requestId: string; maxOutputTokens?: number }): Promise<unknown> {
    if (!input.requestId || input.requestId.length > 200) return Promise.reject(new Error("request_id_required"));
    const key = `${rootTaskId}:${input.requestId}`;
    const prior = this.pending.get(key);
    if (prior) return prior.maxOutputTokens === input.maxOutputTokens ? prior.operation : Promise.reject(new Error("cost_resume_request_conflict"));
    const operation = this.performResume(rootTaskId, input);
    this.pending.set(key, { maxOutputTokens: input.maxOutputTokens, operation });
    void operation.finally(() => this.pending.delete(key)).catch(() => {});
    return operation;
  }
  private async performResume(rootTaskId: string, input: { requestId: string; maxOutputTokens?: number }): Promise<unknown> {
    const previous = this.db.query<{ state: string; result_json: string | null }, [string, string]>("SELECT state,result_json FROM cost_actions WHERE root_task_id=? AND request_id=? AND kind='resume'").get(rootTaskId, input.requestId);
    if (previous) {
      const saved = previous.result_json ? JSON.parse(previous.result_json) as { maxOutputTokens?: number; error?: string } : {};
      if (saved.maxOutputTokens !== input.maxOutputTokens) throw new Error("cost_resume_request_conflict");
      if (previous.state === "completed") return saved;
      throw new Error(saved.error ?? "cost_resume_requires_review");
    }
    const command = this.commands.get(rootTaskId);
    if (!command || command.status === "revoked") throw new Error("command_not_found");
    if (!["paused", "interrupted"].includes(command.status)) throw new Error("cost_task_not_paused");
    const ledger = new CostLedger(this.db), budgets = new BudgetLedger(this.db);
    const account = budgets.get(rootTaskId) ? budgets.summary(rootTaskId) : null;
    const uncertain = ledger.list({ rootTaskId }).some(item => item.state === "outcome_unknown" && !item.reconciliation || item.state === "sent");
    if (uncertain || account && account.mode !== "tracking_only" && ledger.summary({ rootTaskId }).unknownCount > 0) throw new Error("cost_budget_reconciliation_required");
    if (account && (account.breached || account.mode !== "tracking_only" && BigInt(account.availableAtomic) <= 0n)) throw new Error("cost_budget_insufficient");
    const row = this.db.query<{ input_json: string }, [string]>("SELECT input_json FROM room_commands WHERE id=?").get(rootTaskId)!;
    const original = JSON.parse(row.input_json) as RoomCommandInput;
    const configuration = this.configuration(rootTaskId);
    const currentCap = configuration?.maxOutputTokens ?? original.maxOutputTokens ?? MAX_AUTOMATIC_OUTPUT_TOKENS;
    if (input.maxOutputTokens !== undefined && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1 || input.maxOutputTokens > currentCap)) throw new Error("resume_output_cap_must_reduce");
    const nextCap = input.maxOutputTokens ?? currentCap;
    const route = this.routing?.routing.get(rootTaskId);
    if (!route && (command.adaptive || this.db.query("SELECT id FROM routing_decisions WHERE root_task_id=?").get(rootTaskId))) throw new Error("routing_runtime_unavailable");
    // A continuation must never ask the current policy to select new members,
    // endpoints or rates. The Broker still admits every physical request.
    const quote = route ? { id: this.frozenResumeQuote(route, nextCap, budgets) }
      : new TaskQuoteService(this.db, new SessionStore(this.db)).quote({ ...original, maxOutputTokens: nextCap,
        ...(account ? { budget: { mode: account.mode, limitAtomic: account.limitAtomic } } : {}) });
    this.db.transaction(() => {
      if (this.db.query("SELECT request_id FROM cost_actions WHERE root_task_id=? AND kind='resume' AND state='started'").get(rootTaskId)) throw new Error("cost_resume_already_running");
      this.db.query("INSERT INTO cost_actions(root_task_id,request_id,kind,state,result_json,created_at) VALUES (?,?,'resume','started',?,?)")
        .run(rootTaskId, input.requestId, JSON.stringify({ maxOutputTokens: input.maxOutputTokens }), new Date().toISOString());
      this.db.query("INSERT INTO cost_actions(root_task_id,request_id,kind,state,result_json,created_at) VALUES (?,?,'configuration','completed',?,?)")
        .run(rootTaskId, input.requestId, JSON.stringify({ maxOutputTokens: nextCap, quoteId: quote.id }), new Date().toISOString());
    }).immediate();
    try {
      if (route) await this.routing!.adaptive.resume(rootTaskId, input.requestId);
      else if (command.kind === "direct") {
        if (!command.runId) throw new Error("agent_run_not_found");
        await this.supervisor.start({ ...this.runner.continuationInput(command.runId), runtimeOptions: {
          ...this.runner.continuationInput(command.runId).runtimeOptions, costRootTaskId: rootTaskId, maxOutputTokens: nextCap } });
      } else if (command.kind === "discussion") this.commands.resumeDiscussion(rootTaskId);
      else {
        const task = command.taskId ? this.tasks.get(command.taskId) : null;
        if (!task || task.state !== "paused") throw new Error("multi_task_not_paused");
        if (["executing", "awaiting_tool_approval"].includes(task.resumeFrom ?? "")) {
          if (this.team.hasPackages(task.id)) {
            const stopped = this.team.list(task.id).find(item => item.state === "budget_stopped");
            if (stopped) this.team.retryInBackground(task.id, stopped.id);
            else this.team.resumeInBackground(task.id);
          } else this.execution.resumeInBackgroundAfterReview(task.id);
        } else await this.coordinator.resumeInBackground(task.id);
      }
      const result = { accepted: true, rootTaskId, quoteId: quote.id, maxOutputTokens: input.maxOutputTokens };
      this.db.query("UPDATE cost_actions SET state='completed',result_json=? WHERE root_task_id=? AND request_id=? AND kind='resume'").run(JSON.stringify(result), rootTaskId, input.requestId);
      new EventStore(this.db).append({ eventId: `budget.resumed:${rootTaskId}:${input.requestId}`, sessionId: command.roomId, taskId: rootTaskId,
        type: "budget.resumed", payload: { rootTaskId, quoteId: quote.id, maxOutputTokens: nextCap } });
      return result;
    } catch (error) {
      this.db.query("UPDATE cost_actions SET state='failed',result_json=? WHERE root_task_id=? AND request_id=? AND kind='resume'").run(
        JSON.stringify({ maxOutputTokens: input.maxOutputTokens, error: error instanceof Error ? error.message : String(error) }), rootTaskId, input.requestId);
      this.db.query("UPDATE cost_actions SET state='failed' WHERE root_task_id=? AND request_id=? AND kind='configuration'").run(rootTaskId, input.requestId);
      throw error;
    }
  }
  private frozenResumeQuote(route: RouteDecision, maxOutputTokens: number, budgets: BudgetLedger): string {
    const workflow = this.routing!.adaptive.get(route.rootTaskId);
    if (!workflow || workflow.decisionId !== route.id) throw new Error("routing_decision_missing");
    if (!["paused_budget", "interrupted"].includes(workflow.status)) throw new Error("cost_task_not_paused");
    const attempt = workflow.attempts.at(-1);
    const candidate = route.candidates.find(item => item.id === attempt?.candidateId);
    if (!attempt || !candidate || !route.quoteId) throw new Error("routing_frozen_candidate_missing");
    assertRoutingCallSlot(this.db, route);
    assertFrozenRouteAvailable(this.db, route, candidate.resolved.agentIds);
    for (const id of attempt.assignments.executorIds) {
      const member = this.db.query<{ execution_eligible: number }, [string, string]>("SELECT execution_eligible FROM session_agents WHERE session_id=? AND agent_id=?").get(route.roomId, id);
      if (!member?.execution_eligible) throw new Error("routing_member_revoked");
    }
    const account = budgets.get(route.rootTaskId) ? budgets.summary(route.rootTaskId) : null;
    if (account && account.mode !== "tracking_only") {
      if (route.features.requiredCapabilities.imageInput || route.features.requiredCapabilities.fileInput) throw new Error("cost_budget_unpriced_modality");
      const blocked = budgets.latestBlocked(route.rootTaskId)?.details;
      const blockedAgent = typeof blocked?.agentId === "string" && candidate.resolved.agentIds.includes(blocked.agentId) ? blocked.agentId : null;
      const nextMembers = blockedAgent ? [blockedAgent] : candidate.resolved.agentIds;
      let required = 0n;
      for (const id of nextMembers) {
        const member = route.members[id]!, price = member.price;
        if (price?.validUntil && Date.parse(price.validUntil) <= Date.now()) throw new Error("cost_budget_price_expired");
        const protocol = member.provider.protocol;
        const officialProvider = protocol === "openai_responses" ? "openai"
          : protocol === "anthropic_messages" && new URL(member.provider.baseUrl).hostname === "api.anthropic.com" ? "anthropic" : null;
        const catalog = member.profile.modelCapabilities.contextWindow;
        const strictEligible = officialProvider && catalog?.catalogProviderId === officialProvider && catalog.catalogRevision
          && Number.isSafeInteger(catalog.catalogValue) && catalog.catalogValue! > 0 && price && price.source !== "preset_estimate";
        if (account.mode === "strict_admission" && !strictEligible) throw new Error("cost_budget_strict_bound_unavailable");
        const inputTokens = account.mode === "strict_admission" ? catalog!.catalogValue!
          : blockedAgent === id && Number.isSafeInteger(blocked?.inputTokenBound) && Number(blocked?.inputTokenBound) > 0
            ? Number(blocked!.inputTokenBound) : route.features.contextTokensRequired;
        const bound = requestCostUpperBound(price, inputTokens, maxOutputTokens);
        if (!bound || bound.currency !== "USD") throw new Error("cost_budget_price_unknown");
        if (BigInt(bound.atomic) > required) required = BigInt(bound.atomic);
      }
      // Older budget records have the exact required amount but not its token
      // basis. Retain that conservative bound until the user adds funds.
      if (typeof blocked?.requiredAtomic === "string" && !blocked.inputTokenBound && BigInt(blocked.requiredAtomic) > required) required = BigInt(blocked.requiredAtomic);
      if (account.breached || required > BigInt(account.availableAtomic)) throw new Error("cost_budget_insufficient");
    }
    return route.quoteId;
  }
  configuration(rootTaskId: string): { maxOutputTokens: number; quoteId: string } | null {
    const row = this.db.query<{ result_json: string }, [string]>("SELECT result_json FROM cost_actions WHERE root_task_id=? AND kind='configuration' AND state='completed' ORDER BY rowid DESC LIMIT 1").get(rootTaskId);
    return row ? JSON.parse(row.result_json) as { maxOutputTokens: number; quoteId: string } : null;
  }
}
