import { test, expect } from "bun:test";
import { ArenaStrategyService } from "./arena-strategy";
import { setupCostFlowFixture } from "./cost-flow-fixture";
import { arenaStrategyMigration } from "../store/migrations/032_arena_strategy";
import type { ArenaExperiment, ArenaTrial } from "@socrates/core";
async function setup() {
	const f = await setupCostFlowFixture();
	if (
		!f.db
			.query(
				"SELECT name FROM sqlite_master WHERE name='arena_strategy_previews'",
			)
			.get()
	)
		arenaStrategyMigration.up(f.db);
	const room = f.sessions.get(f.roomIds.work)!,
		collaboration = structuredClone(room.collaboration);
	collaboration.strategy = "single";
	const e = {
		id: "experiment",
		sourceWorkspaceId: room.workspaceId,
		definition: {
			roomId: room.id,
			mode: "controlled",
			datasetVersion: "dataset-v1",
			repeats: 1,
			tasks: ["one", "two", "three"].map((id) => ({ id, category: "fixture" })),
			variants: [
				{ id: "selected", primaryAgentId: room.primaryAgentId, collaboration },
			],
		},
		snapshotHash: "frozen",
		status: "completed",
		createdAt: "now",
		trials: [],
		evaluatorVersion: "checks-v1",
	} as unknown as ArenaExperiment;
	f.db
		.query("INSERT INTO arena_experiments VALUES(?,?,?,?,?,?)")
		.run(e.id, room.id, "fixture", "hash", JSON.stringify(e), "{}");
	for (const task of e.definition.tasks) {
		const trialRoom = f.sessions.create({
			title: "strategy trial",
			mode: "multi_agent",
			workspaceId: room.workspaceId!,
			primaryAgentId: room.primaryAgentId!,
			agents: room.agents,
			collaborationDefaults: collaboration,
		});
		const t: ArenaTrial = {
			id: task.id,
			experimentId: e.id,
			taskId: task.id,
			variantId: "selected",
			repeat: 0,
			roomId: trialRoom.id,
			workspaceId: room.workspaceId!,
			status: "completed",
			outcome: "verified_success",
			knownAtomic: "100",
			estimatedAtomic: "0",
			unknownCount: 0,
			snapshotHash: e.snapshotHash,
			startedAt: "start",
			finishedAt: "finish",
		};
		f.db
			.query("INSERT INTO arena_trials VALUES(?,?,?,?)")
			.run(t.id, e.id, t.roomId, JSON.stringify(t));
	}
	return { f, e, service: new ArenaStrategyService(f.db, f.sessions) };
}
test("preview records controlled evidence without autoapplying; explicit apply/rollback preserve idempotence", async () => {
	const { f, e, service } = await setup();
	try {
		const original = f.sessions.get(f.roomIds.work)!.collaboration;
		const p = service.preview(e.id, "selected");
		expect(p.eligible).toBe(true);
		expect(p.interpretation).toBe("demonstration_configuration");
		expect(p.evidence.taskCount).toBe(3);
		expect(f.sessions.get(f.roomIds.work)!.collaboration).toEqual(original);
		const applied = service.apply(f.roomIds.work, p.hash, "apply", true);
		expect(f.sessions.get(f.roomIds.work)!.collaboration.strategy).toBe(
			"single",
		);
		expect(service.apply(f.roomIds.work, p.hash, "apply", true).id).toBe(
			applied.id,
		);
		expect(
			service.rollback(f.roomIds.work, applied.id, "rollback").rolledBack,
		).toBe(true);
		expect(
			service.rollback(f.roomIds.work, applied.id, "rollback").rolledBack,
		).toBe(true);
		expect(f.sessions.get(f.roomIds.work)!.collaboration).toEqual(original);
	} finally {
		await f.close();
	}
});
test("configuration drift, other-room requests and revoked providers cannot apply", async () => {
	const { f, e, service } = await setup();
	try {
		const p = service.preview(e.id, "selected");
		expect(() =>
			service.apply(f.roomIds.chat, p.hash, "wrong", true),
		).toThrow();
		const room = f.sessions.get(f.roomIds.work)!;
		f.sessions.updateCollaboration(room.id, {
			...room.collaboration,
			strategy: "single",
		});
		expect(() => service.apply(room.id, p.hash, "stale", true)).toThrow(
			"arena_strategy_preview_stale",
		);
		const next = service.preview(e.id, "selected");
		f.db.exec("UPDATE providers SET enabled=0");
		expect(() => service.apply(room.id, next.hash, "revoked", true)).toThrow();
	} finally {
		await f.close();
	}
});
test("rollback never overwrites intervening user choices", async () => {
	const { f, e, service } = await setup();
	try {
		const p = service.preview(e.id, "selected"),
			v = service.apply(f.roomIds.work, p.hash, "apply", true);
		const room = f.sessions.get(f.roomIds.work)!;
		f.sessions.updateCollaboration(room.id, {
			...room.collaboration,
			discussion: { ...room.collaboration.discussion, maxRounds: 3 },
		});
		expect(() => service.rollback(room.id, v.id, "rollback")).toThrow(
			"arena_strategy_config_changed",
		);
	} finally {
		await f.close();
	}
});
test("incomplete or undersampled evidence remains ineligible and frozen profile mismatch is visible", async () => {
	const { f, e, service } = await setup();
	try {
		f.db.exec("DELETE FROM arena_trials WHERE id='three'");
		const p = service.preview(e.id, "selected");
		expect(p.eligible).toBe(false);
		expect(p.blockers).toContain("arena_strategy_insufficient_tasks");
		expect(p.blockers).toContain("arena_strategy_incomplete");
		expect(() =>
			service.apply(f.roomIds.work, p.hash, "blocked", true),
		).toThrow();
		const room = f.sessions.get(f.roomIds.work)!;
		f.sessions.updateAgentSnapshot(room.id, room.agents[0]!.agentId, {
			...room.agents[0]!.snapshot,
			modelId: "changed-model",
		});
		expect(service.preview(e.id, "selected").blockers).toContain(
			"arena_strategy_profile_changed",
		);
	} finally {
		await f.close();
	}
});
test("repeats are not independent tasks and missing successful or priced evidence blocks adoption", async () => {
	const { f, e, service } = await setup();
	try {
		for (const row of f.db
			.query<{ id: string; trial_json: string }, []>(
				"SELECT id,trial_json FROM arena_trials",
			)
			.all()) {
			const trial = JSON.parse(row.trial_json);
			trial.taskId = "one";
			trial.unknownCount = 1;
			trial.outcome = "verification_failed";
			f.db
				.query("UPDATE arena_trials SET trial_json=? WHERE id=?")
				.run(JSON.stringify(trial), row.id);
		}
		const p = service.preview(e.id, "selected");
		expect(p.evidence.taskCount).toBe(1);
		expect(p.blockers).toContain("arena_strategy_insufficient_tasks");
		expect(p.blockers).toContain("arena_strategy_no_verified_success");
		expect(p.blockers).toContain("arena_strategy_unknown_cost");
		expect(() => service.apply(f.roomIds.work, p.hash, "no", true)).toThrow();
	} finally {
		await f.close();
	}
});
