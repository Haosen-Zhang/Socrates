import { test, expect } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { setupCostFlowFixture } from "./cost-flow-fixture";
import { ArenaService } from "./arena-service";
import { BudgetLedger } from "./cost-ledger";
import {
	arenaMetrics,
	type ArenaDefinition,
} from "../../../../packages/core/src/arena";
function definition(
	f: Awaited<ReturnType<typeof setupCostFlowFixture>>,
): ArenaDefinition {
	const c = structuredClone(f.sessions.get(f.roomIds.work)!.collaboration);
	c.strategy = "single";
	c.assignment.routing.mode = "manual";
	c.assignment.routing.lightweightAgentId = "fixture-a";
	return {
		schemaVersion: 1,
		roomId: f.roomIds.work,
		requestId: "experiment",
		label: "Controlled arena",
		datasetVersion: "fixtures-v1",
		files: ["context.txt"],
		tasks: [
			{
				id: "task",
				category: "simple-fix",
				prompt: "Create controlled result",
				checks: [
					{
						id: "result",
						label: "exists",
						kind: "file",
						path: "result.txt",
						required: true,
						origin: "user",
					},
				],
				artifactPaths: ["result.txt"],
				protectedPaths: [],
			},
		],
		variants: ["A", "B", "C", "D"].map((id) => ({
			id,
			label: id,
			primaryAgentId: "fixture-a",
			collaboration: c,
		})),
		repeats: 1,
		concurrency: 2,
		timeoutMs: 10000,
		groupBudgetAtomic: "1000000000000000",
		trialBudgetAtomic: "1000000000000000",
		mode: "controlled",
		authorizeLive: false,
		acknowledgeSnapshot: true,
	};
}
test("Arena creates identical isolated snapshots and preserves real project, duplicate prepare is inert", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	try {
		const service = new ArenaService(f.db, {
			...f,
			baseDirectory: join(f.directory, "arena"),
			controlled: true,
		});
		const e = service.prepare(definition(f));
		expect(e.trials).toHaveLength(4);
		expect(new Set(e.trials.map((t) => t.workspaceId)).size).toBe(4);
		for (const t of e.trials)
			expect(
				readFileSync(
					join(f.workspaces.get(t.workspaceId)!.canonicalPath, "context.txt"),
					"utf8",
				),
			).toBe(
				readFileSync(join(f.workspace.canonicalPath, "context.txt"), "utf8"),
			);
		expect(service.prepare(definition(f)).id).toBe(e.id);
		expect(f.nativeCalls.length).toBe(0);
		expect(existsSync(join(f.workspace.canonicalPath, "result.txt"))).toBe(
			false,
		);
	} finally {
		await f.close();
	}
});
test("Arena drives actual Native task commands and links parent budget before requests", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.variants = input.variants.slice(0, 1);
		const e = service.prepare(input);
		service.start(e.id);
		await service.wait(e.id);
		const result = service.view(e.id);
		expect(result.trials[0]!.reason).toBeUndefined();
		expect(result.trials[0]!.commandId).toBeDefined();
		expect(
			new BudgetLedger(f.db).get(result.trials[0]!.commandId!)!.parentId,
		).toBe(e.id);
		expect(f.nativeCalls.length).toBeGreaterThan(0);
		const before = f.nativeCalls.length;
		service.start(e.id);
		await service.wait(e.id);
		expect(f.nativeCalls.length).toBe(before);
	} finally {
		await service.shutdown();
		await f.close();
	}
}, 20000);
test("Arena refuses unauthorised live/controlled mode and secret paths", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	try {
		const service = new ArenaService(f.db, {
			...f,
			baseDirectory: join(f.directory, "arena"),
		});
		expect(() => service.prepare(definition(f))).toThrow(
			"arena_controlled_transport_unavailable",
		);
		const d = { ...definition(f), mode: "live" as const };
		expect(() => service.prepare(d)).toThrow(
			"arena_live_authorization_required",
		);
		d.authorizeLive = true;
		d.files = [".env.local"];
		expect(() => service.prepare(d)).toThrow("arena_secret_excluded");
	} finally {
		await f.close();
	}
});
test("Arena zero success, unpriced and incomplete metrics never invent exact CPVS", () => {
	expect(arenaMetrics([]).costPerVerifiedSuccessAtomic).toBeNull();
	const t = {
		id: "t",
		experimentId: "e",
		taskId: "t",
		variantId: "a",
		repeat: 0,
		roomId: "r",
		workspaceId: "w",
		status: "completed" as const,
		outcome: "verified_success",
		knownAtomic: "10",
		estimatedAtomic: "0",
		unknownCount: 1,
		snapshotHash: "h",
	};
	expect(arenaMetrics([t]).costPerVerifiedSuccessAtomic).toBeNull();
	expect(
		arenaMetrics([{ ...t, unknownCount: 0 }]).costPerVerifiedSuccessAtomic,
	).toBe("10");
	expect(arenaMetrics([{ ...t, status: "planned" }]).incomplete).toBe(true);
});
test("four actual variants preserve A/B executor identity, C manager and D independent reviewer with billed calls", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.concurrency = 1;
		input.variants = input.variants.map((v, i) => {
			const c = structuredClone(v.collaboration);
			c.strategy = i < 2 ? "single" : "team";
			c.assignment.coordinatorAgentId = "fixture-a";
			c.assignment.routing.lightweightAgentId =
				i === 0 ? "fixture-a" : "fixture-b";
			c.assignment.routing.complexAgentId =
				c.assignment.routing.lightweightAgentId;
			c.assignment.routing.criticalAgentId =
				c.assignment.routing.lightweightAgentId;
			c.planConfirmation.reviewerAgentId = i === 3 ? "fixture-c" : null;
			return {
				...v,
				primaryAgentId: i === 0 ? "fixture-a" : "fixture-b",
				collaboration: c,
			};
		});
		const e = service.prepare(input);
		service.start(e.id);
		await service.wait(e.id);
		let view = service.view(e.id);
		expect(
			view.trials.slice(0, 2).every((t) => t.outcome === "verified_success"),
		).toBe(true);
		expect(view.trials.slice(2).every((t) => t.status === "waiting")).toBe(
			true,
		);
		for (const t of view.trials.slice(2)) {
			const child = f.adaptive.get(t.commandId!)!.attempts.at(-1)!.child!,
				plan = f.tasks.getPlan(child.id)!;
			const response = await f.app.request(
				`/multi/tasks/${child.id}/plan-decisions`,
				{
					method: "POST",
					headers: f.headers,
					body: JSON.stringify({
						version: plan.version,
						hash: plan.contentHash,
						decision: "approve_exact_plan",
						clientDecisionKey: crypto.randomUUID(),
					}),
				},
			);
			expect(response.status).toBe(200);
		}
		service.start(e.id);
		await service.wait(e.id);
		view = service.view(e.id);
		expect(view.trials.every((t) => t.outcome === "verified_success")).toBe(
			true,
		);
		const decisions = view.trials.map((t) => f.routes.get(t.commandId!)!);
		expect(decisions[0]!.selected!.assignments.executorIds).toEqual([
			"fixture-a",
		]);
		expect(decisions[1]!.selected!.assignments.executorIds).toEqual([
			"fixture-b",
		]);
		expect(decisions[2]!.selected!.assignments.managerId).toBe("fixture-a");
		expect(decisions[3]!.selected!.assignments.reviewerId).toBe("fixture-c");
		expect(
			f.gatewayCalls.some(
				(c) => c.purpose === "plan" && c.agentId === "fixture-a",
			),
		).toBe(true);
		expect(
			f.gatewayCalls.some(
				(c) => c.purpose === "review" && c.agentId === "fixture-c",
			),
		).toBe(true);
		expect(view.trials.every((t) => BigInt(t.knownAtomic) > 0n)).toBe(true);
	} finally {
		await service.shutdown();
		await f.close();
	}
}, 30000);
test("concurrent trials obey experiment admission and budget-blocked samples remain in denominator", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.groupBudgetAtomic = "1";
		input.concurrency = 4;
		const e = service.prepare(input);
		service.start(e.id);
		await service.wait(e.id);
		const result = service.results(e.id);
		expect(f.nativeCalls.length).toBe(0);
		expect(result.metrics.planned).toBe(4);
		expect(result.metrics.verified).toBe(0);
		expect(result.metrics.costPerVerifiedSuccessAtomic).toBeNull();
		expect(
			BigInt(new BudgetLedger(f.db).summary(e.id).activeReservationsAtomic),
		).toBe(0n);
	} finally {
		await service.shutdown();
		await f.close();
	}
});
test("completed trials survive new service owner recovery without dispatch or extra charges", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const deps = {
			...f,
			baseDirectory: join(f.directory, "arena"),
			controlled: true,
		},
		service = new ArenaService(f.db, deps);
	try {
		const d = definition(f);
		d.variants = d.variants.slice(0, 1);
		const e = service.prepare(d);
		service.start(e.id);
		await service.wait(e.id);
		const before = JSON.stringify(new BudgetLedger(f.db).summary(e.id)),
			calls = f.nativeCalls.length;
		const restored = new ArenaService(f.db, deps);
		restored.recover();
		restored.start(e.id);
		await restored.wait(e.id);
		expect(f.nativeCalls.length).toBe(calls);
		expect(JSON.stringify(new BudgetLedger(f.db).summary(e.id))).toBe(before);
		expect(restored.view(e.id).trials[0]!.outcome).toBe("verified_success");
	} finally {
		await service.shutdown();
		await f.close();
	}
});
test("five offline task categories execute real writes/checks and preserve budget failures", async () => {
	const { ARENA_OFFLINE_FIXTURES, arenaFixtureToolCalls } = await import(
		"./arena-offline-fixtures"
	);
	const { writeFileSync } = await import("node:fs");
	for (const scenario of ARENA_OFFLINE_FIXTURES) {
		const f = await setupCostFlowFixture({
			routingFixture: true,
			nativeToolCalls: arenaFixtureToolCalls,
		});
		const service = new ArenaService(f.db, {
			...f,
			baseDirectory: join(f.directory, "arena"),
			controlled: true,
		});
		try {
			for (const [path, content] of Object.entries(scenario.files))
				writeFileSync(join(f.workspace.canonicalPath, path), content);
			const input = definition(f);
			input.tasks = [scenario.task];
			input.files = Object.keys(scenario.files);
			input.variants = input.variants.slice(0, 1);
			input.groupBudgetAtomic =
				scenario.budgetAtomic ?? input.groupBudgetAtomic;
			const e = service.prepare(input);
			service.start(e.id);
			await service.wait(e.id);
			let trial = service.view(e.id).trials[0]!;
			for (let n = 0; n < 4 && trial.status === "waiting"; n++) {
				const view = f.verification.view({
					roomId: trial.roomId,
					rootTaskId: trial.commandId!,
				});
				for (const approval of view.run?.pendingApprovals ?? []) {
					const response = await f.app.request(
						`/verification/approvals/${approval.id}/decision`,
						{
							method: "POST",
							headers: f.headers,
							body: JSON.stringify({
								requestId: crypto.randomUUID(),
								decision: "allow_once",
							}),
						},
					);
					expect(response.status).toBe(200);
				}
				service.start(e.id);
				await service.wait(e.id);
				trial = service.view(e.id).trials[0]!;
			}
			if (scenario.id === "budget-insufficient") {
				expect(f.nativeCalls.length).toBe(0);
				expect(trial.outcome).not.toBe("verified_success");
			} else if (scenario.id === "dependency-failure") {
				expect(trial.outcome).not.toBe("verified_success");
				expect(f.nativeCalls.length).toBeGreaterThan(0);
			} else {
				if (trial.outcome !== "verified_success")
					console.log(
						scenario.id,
						trial.reason,
						trial.commandId
							? f.verification
									.view({ roomId: trial.roomId, rootTaskId: trial.commandId })
									.run?.evidence.map((e) => ({
										reason: e.reason,
										diagnostics: e.diagnostics,
									}))
							: null,
					);
				expect(trial.outcome).toBe("verified_success");
				for (const path of Object.keys(scenario.writes))
					expect(
						readFileSync(
							join(f.workspaces.get(trial.workspaceId)!.canonicalPath, path),
							"utf8",
						),
					).toBe(scenario.writes[path]!);
			}
			for (const [path, content] of Object.entries(scenario.files))
				expect(
					readFileSync(join(f.workspace.canonicalPath, path), "utf8"),
				).toBe(content);
		} finally {
			await service.shutdown();
			await f.close();
		}
	}
}, 30000);
test("cancelling pending team keeps consumed planning costs and cleanup never touches source", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.variants = input.variants.slice(0, 1);
		input.variants[0]!.collaboration.strategy = "team";
		const e = service.prepare(input);
		service.start(e.id);
		await service.wait(e.id);
		const t = service.view(e.id).trials[0]!;
		expect(t.status).toBe("waiting");
		expect(BigInt(t.knownAtomic)).toBeGreaterThan(0n);
		await service.cancel(e.id);
		const cancelled = service.view(e.id).trials[0]!;
		expect(cancelled.status).toBe("cancelled");
		expect(BigInt(cancelled.knownAtomic)).toBeGreaterThan(0n);
		const calls = f.gatewayCalls.length,
			cost = new BudgetLedger(f.db).summary(e.id);
		expect(() => service.cleanup(e.id, false)).toThrow(
			"arena_cleanup_confirmation_required",
		);
		const cleaned = service.cleanup(e.id, true);
		expect(cleaned.artifactsExpiredAt).toBeDefined();
		expect(existsSync(f.workspace.canonicalPath)).toBe(true);
		expect(existsSync(f.workspaces.get(t.workspaceId)!.canonicalPath)).toBe(
			false,
		);
		expect(new BudgetLedger(f.db).summary(e.id).settledKnownAtomic).toBe(
			cost.settledKnownAtomic,
		);
		expect(f.gatewayCalls.length).toBe(calls);
		expect(() => service.start(e.id)).toThrow("arena_artifacts_expired");
	} finally {
		await service.shutdown();
		await f.close();
	}
});
test("preparation invalid checks roll back only fresh arena state and snapshot replay detects changes", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.tasks[0]!.artifactPaths = ["../outside"];
		expect(() => service.prepare(input)).toThrow();
		expect(service.list(f.roomIds.work)).toHaveLength(0);
		expect(f.sessions.list()).toHaveLength(2);
		const clean = definition(f);
		const e = service.prepare(clean);
		expect(() =>
			service.prepare({
				...clean,
				requestId: "changed",
				expectedSnapshotHash: "0".repeat(64),
			}),
		).toThrow("arena_start_snapshot_changed");
		expect(service.list(f.roomIds.work)).toHaveLength(1);
		expect(e.trials).toHaveLength(4);
	} finally {
		await f.close();
	}
});
test("redacted exports and formula-safe CSV keep long harmless configuration intact", async () => {
	const { arenaExport, arenaCsv } = await import("./arena-export");
	const safe = arenaExport({
		prompt: "safe".repeat(3000),
		api: "sk-abcdefghijk123456",
		header: "Authorization: Bearer abcdefg",
		path: "/Users/private/file",
	});
	expect(safe.redacted).toBe(true);
	expect(JSON.stringify(safe.data)).not.toContain("sk-abcdefgh");
	expect(safe.data.prompt.length).toBe(12000);
	expect(safe.data.path).toContain("REDACTED");
	expect(
		arenaCsv([
			{
				taskId: "=SUM(A1)",
				variantId: "A",
				repeat: 0,
				status: "planned",
				knownAtomic: "0",
				estimatedAtomic: "0",
				unknownCount: 0,
			},
		]),
	).toContain("'=SUM(A1)");
});
test("results refresh verification invalidation and reconciled charges instead of cached success", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.variants = input.variants.slice(0, 1);
		const e = service.prepare(input);
		service.start(e.id);
		await service.wait(e.id);
		const t = service.results(e.id).trials[0]!;
		expect(t.outcome).toBe("verified_success");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(f.workspaces.get(t.workspaceId)!.canonicalPath, "result.txt"),
			"changed after check",
		);
		const { CostLedger } = await import("./cost-ledger");
		const ledger = new CostLedger(f.db),
			invocation = ledger.list({ rootTaskId: t.commandId })[0]!;
		ledger.reconcile(invocation.invocationId, {
			requestId: "invoice",
			totalAtomic: "1234567",
			currency: "USD",
			reason: "controlled invoice correction",
		});
		const result = service.results(e.id);
		expect(result.metrics.verified).toBe(0);
		expect(result.trials[0]!.outcome).toBe("completed_unverified");
		expect(result.trials[0]!.knownAtomic).toBe(
			ledger.summary({ rootTaskId: t.commandId }).totals[0]!.atomic,
		);
		expect(service.view(e.id).trials[0]!.outcome).toBe("completed_unverified");
	} finally {
		await service.shutdown();
		await f.close();
	}
});
test("expired preflight refreshes an unchanged bound quote before first dispatch", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.variants = input.variants.slice(0, 1);
		const e = service.prepare(input),
			t = e.trials[0]!;
		const old = t.quote!.id;
		f.db
			.query(
				"UPDATE cost_quotes SET quote_json=json_set(quote_json,'$.expiresAt','2000-01-01T00:00:00Z') WHERE id=?",
			)
			.run(old);
		t.quote!.expiresAt = "2000-01-01T00:00:00Z";
		f.db
			.query("UPDATE arena_trials SET trial_json=? WHERE id=?")
			.run(JSON.stringify(t), t.id);
		service.start(e.id);
		await service.wait(e.id);
		expect(service.results(e.id).trials[0]!.outcome).toBe("verified_success");
		expect(service.view(e.id).trials[0]!.quote!.id).not.toBe(old);
	} finally {
		await service.shutdown();
		await f.close();
	}
});
test("revoked source member permission prevents frozen trial from sending a model request", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.variants = input.variants.slice(0, 1);
		const e = service.prepare(input);
		f.db
			.query(
				"UPDATE session_agents SET execution_eligible=0 WHERE session_id=? AND agent_id=?",
			)
			.run(f.roomIds.work, "fixture-a");
		service.start(e.id);
		await service.wait(e.id);
		expect(f.nativeCalls).toHaveLength(0);
		expect(f.gatewayCalls).toHaveLength(0);
		expect(service.results(e.id).metrics.verified).toBe(0);
	} finally {
		await service.shutdown();
		await f.close();
	}
});
test("cancelling an already completed experiment is idempotent and preserves completion", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	try {
		const input = definition(f);
		input.variants = input.variants.slice(0, 1);
		const e = service.prepare(input);
		service.start(e.id);
		await service.wait(e.id);
		const completed = service.view(e.id),
			calls = f.nativeCalls.length;
		expect(completed.status).toBe("completed");
		expect(await service.cancel(e.id)).toEqual(completed);
		expect(await service.cancel(e.id)).toEqual(completed);
		expect(f.nativeCalls.length).toBe(calls);
	} finally {
		await service.shutdown();
		await f.close();
	}
});
