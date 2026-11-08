import type { Database } from "bun:sqlite";
import { BudgetLedger } from "./cost-ledger";
/** Server-owned trial membership is the only cross-room budget authority. */
export function arenaBudgetParentAllowed(
	db: Database,
	roomId: string,
	parentId: string,
): boolean {
	if (
		!db.query("SELECT name FROM sqlite_master WHERE name='arena_trials'").get()
	)
		return false;
	return Boolean(
		db
			.query(
				"SELECT t.id FROM arena_trials t JOIN arena_experiments e ON e.id=t.experiment_id WHERE t.room_id=? AND e.id=?",
			)
			.get(roomId, parentId),
	);
}
export function linkArenaBudget(
	db: Database,
	roomId: string,
	rootTaskId: string,
): void {
	if (
		!db.query("SELECT name FROM sqlite_master WHERE name='arena_trials'").get()
	)
		return;
	const row = db
		.query<{ experiment_id: string; trial_json: string }, [string]>(
			"SELECT experiment_id,trial_json FROM arena_trials WHERE room_id=?",
		)
		.get(roomId);
	if (!row) return;
	const budget = new BudgetLedger(db),
		child = budget.get(rootTaskId),
		parent = budget.get(row.experiment_id);
	if (!child || !parent) throw new Error("arena_budget_missing");
	if (child.parentId && child.parentId !== parent.rootTaskId)
		throw new Error("arena_budget_parent_conflict");
	const trial = JSON.parse(row.trial_json);
	if (trial.commandId && trial.commandId !== rootTaskId)
		throw new Error("arena_trial_command_conflict");
	db.query(
		"UPDATE cost_budget_accounts SET parent_id=? WHERE root_task_id=? AND parent_id IS NULL",
	).run(parent.rootTaskId, rootTaskId);
	trial.commandId = rootTaskId;
	db.query("UPDATE arena_trials SET trial_json=? WHERE room_id=?").run(
		JSON.stringify(trial),
		roomId,
	);
}
/** Frozen experiment configuration does not freeze the source room's authorization. */
export function assertArenaInvocationAllowed(
	db: Database,
	roomId: string,
	agentId: string,
	providerId: string,
): void {
	if (
		!db.query("SELECT name FROM sqlite_master WHERE name='arena_trials'").get()
	)
		return;
	const row = db
		.query<{ experiment_json: string }, [string]>(
			"SELECT e.experiment_json FROM arena_trials t JOIN arena_experiments e ON e.id=t.experiment_id WHERE t.room_id=?",
		)
		.get(roomId);
	if (!row) return;
	const experiment = JSON.parse(row.experiment_json);
	const source = db
		.query<
			{
				workspace_id: string;
				archived: number;
				collaboration_json: string | null;
			},
			[string]
		>(
			"SELECT workspace_id,archived,collaboration_json FROM sessions WHERE id=?",
		)
		.get(experiment.definition.roomId);
	const member = db
		.query<
			{ execution_eligible: number; snapshot_json: string },
			[string, string]
		>(
			"SELECT execution_eligible,snapshot_json FROM session_agents WHERE session_id=? AND agent_id=?",
		)
		.get(experiment.definition.roomId, agentId);
	if (
		!source ||
		source.archived ||
		source.workspace_id !== experiment.sourceWorkspaceId ||
		!member?.execution_eligible
	)
		throw new Error("arena_source_permission_revoked");
	const current = JSON.parse(member.snapshot_json);
	if (current.providerId !== providerId)
		throw new Error("arena_source_provider_changed");
	const allowed = source.collaboration_json
		? JSON.parse(source.collaboration_json)?.assignment?.routing
				?.allowedProviderIds
		: undefined;
	if (Array.isArray(allowed) && !allowed.includes(providerId))
		throw new Error("arena_source_provider_denied");
	if (experiment.status === "cancelled")
		throw new Error("arena_experiment_cancelled");
}
