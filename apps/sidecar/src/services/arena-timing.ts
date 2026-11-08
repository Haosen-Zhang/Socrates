import type { Database } from "bun:sqlite";
import type { ArenaTrial } from "../../../../packages/core/src/arena";
const interval = (
	start?: string | null,
	end?: string | null,
): number | null => {
	if (!start || !end) return null;
	const n = Date.parse(end) - Date.parse(start);
	return Number.isFinite(n) && n >= 0 ? n : null;
};
export function arenaTiming(db: Database, trial: ArenaTrial) {
	const approvals = db
		.query<{ created_at: string; decided_at: string | null }, [string]>(
			`SELECT r.created_at,MIN(d.decided_at) decided_at FROM approval_requests r LEFT JOIN approval_decisions d ON d.request_id=r.id WHERE r.session_id=? GROUP BY r.id`,
		)
		.all(trial.roomId);
	const tools = db
		.query<{ started_at: string; completed_at: string | null }, [string]>(
			`SELECT a.started_at,a.completed_at FROM tool_attempts a JOIN tool_calls t ON t.id=a.tool_operation_id WHERE t.session_id=?`,
		)
		.all(trial.roomId);
	const checks = db
		.query<{ evidence_json: string }, [string]>(
			`SELECT e.evidence_json FROM verification_evidence e JOIN verification_runs r ON r.id=e.run_id WHERE r.room_id=?`,
		)
		.all(trial.roomId);
	const requests = db
		.query<{ created_at: string; finished_at: string | null }, [string]>(
			`SELECT i.created_at,MIN(e.occurred_at) finished_at FROM cost_invocations i LEFT JOIN task_events e ON json_extract(e.payload_json,'$.invocationId')=i.id AND e.type IN ('cost.invocation_priced','cost.reconciliation_required') WHERE i.room_id=? GROUP BY i.id`,
		)
		.all(trial.roomId);
	const sum = (items: Array<number | null>) =>
		items.some((n) => n === null)
			? null
			: items.reduce<number>((n, v) => n + v!, 0);
	return {
		wallMs: interval(trial.startedAt, trial.finishedAt),
		queueMs: interval(trial.queuedAt, trial.startedAt),
		modelRequestLifecycleMs: sum(
			requests.map((r) => interval(r.created_at, r.finished_at)),
		),
		toolMs: sum(tools.map((r) => interval(r.started_at, r.completed_at))),
		verificationMs: sum(
			checks.map((r) => {
				const e = JSON.parse(r.evidence_json);
				return typeof e.durationMs === "number" ? e.durationMs : null;
			}),
		),
		waitingHumanMs: sum(
			approvals.map((r) => interval(r.created_at, r.decided_at)),
		),
		humanInterventions: approvals.filter((r) => r.decided_at).length,
		humanActiveMs: null,
		aggregation: "stage_intervals_may_overlap_not_additive",
	};
}
