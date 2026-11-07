import type { Database } from "bun:sqlite";
import { MAX_AUTOMATIC_OUTPUT_TOKENS, type RoomCommandInput } from "@socrates/core";
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

/** Resume reuses original room/task and durable tool facts, never submits a new task. */
export class CostTaskService {
  private readonly pending = new Map<string, { maxOutputTokens?: number; operation: Promise<unknown> }>();
  constructor(private readonly db: Database, private readonly commands: RoomCommandService,
    private readonly supervisor: RunSupervisor, private readonly runner: SingleAgentRunner,
    private readonly tasks: MultiTaskStore, private readonly coordinator: MultiAgentCoordinator,
    private readonly team: TeamRunner, private readonly execution: ExecutionRunner) {
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
    const quote = new TaskQuoteService(this.db, new SessionStore(this.db)).quote({ ...original, maxOutputTokens: nextCap,
      ...(account ? { budget: { mode: account.mode, limitAtomic: account.limitAtomic } } : {}) });
    this.db.transaction(() => {
      if (this.db.query("SELECT request_id FROM cost_actions WHERE root_task_id=? AND kind='resume' AND state='started'").get(rootTaskId)) throw new Error("cost_resume_already_running");
      this.db.query("INSERT INTO cost_actions(root_task_id,request_id,kind,state,result_json,created_at) VALUES (?,?,'resume','started',?,?)")
        .run(rootTaskId, input.requestId, JSON.stringify({ maxOutputTokens: input.maxOutputTokens }), new Date().toISOString());
      this.db.query("INSERT INTO cost_actions(root_task_id,request_id,kind,state,result_json,created_at) VALUES (?,?,'configuration','completed',?,?)")
        .run(rootTaskId, input.requestId, JSON.stringify({ maxOutputTokens: nextCap, quoteId: quote.id }), new Date().toISOString());
    }).immediate();
    try {
      if (command.kind === "direct") {
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
  configuration(rootTaskId: string): { maxOutputTokens: number; quoteId: string } | null {
    const row = this.db.query<{ result_json: string }, [string]>("SELECT result_json FROM cost_actions WHERE root_task_id=? AND kind='configuration' AND state='completed' ORDER BY rowid DESC LIMIT 1").get(rootTaskId);
    return row ? JSON.parse(row.result_json) as { maxOutputTokens: number; quoteId: string } : null;
  }
}
