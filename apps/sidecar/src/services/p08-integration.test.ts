import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";
import { FlightRecorderService } from "./flight-recorder";

test("S12 real planned failure escalates with exact approval, shared memory and independently verified trace", async () => {
	let workspace = "";
	const seen = new Set<string>();
	const bodies: unknown[] = [];
	const f = await setupCostFlowFixture({
		routingFixture: true,
		onNativeRequest: (body) => bodies.push(body),
		nativeToolCalls: (raw) => {
			const body = raw as { model: string };
			if (seen.has(body.model)) return [];
			seen.add(body.model);
			const path = join(workspace, "result.txt");
			const content =
				body.model === "fixture-model-c"
					? "independently accepted repair"
					: "incorrect first output";
			return [
				{
					id: "controlled-write",
					type: "function",
					function: {
						name: "write_file",
						arguments: JSON.stringify({
							path: "result.txt",
							content,
							...(existsSync(path)
								? {
										expectedSha256: createHash("sha256")
											.update(readFileSync(path))
											.digest("hex"),
									}
								: {}),
						}),
					},
				},
			];
		},
	});
	workspace = f.workspace.canonicalPath;
	try {
		for (const name of ["module-a", "module-b"]) {
			mkdirSync(join(workspace, name));
			writeFileSync(
				join(workspace, name, "package.json"),
				JSON.stringify({ name }),
			);
			writeFileSync(join(workspace, name, "readme.md"), "controlled module");
		}
		writeFileSync(join(workspace, "security.md"), "controlled acceptance");
		const room = f.sessions.get(f.roomIds.work)!;
		f.sessions.updateCollaboration(room.id, {
			...room.collaboration,
			strategy: "adaptive",
			assignment: {
				...room.collaboration.assignment,
				callableAgentIds: ["fixture-a", "fixture-b", "fixture-c"],
				routing: {
					...room.collaboration.assignment.routing,
					automaticPolicy: "balanced",
					fallbackAgentIds: ["fixture-c"],
					limits: { maxRetries: 0, maxEscalations: 1, maxTotalModelCalls: 24 },
				},
			},
		});
		const memory = f.projectMemory.save(
			room.id,
			{
				kind: "constraint",
				content: "P08_PRIVATE_BACKGROUND: keep API compatibility",
				allowedProviders: ["fixture-provider"],
			},
			{ status: "confirmed" },
		);
		const draft = f.verification.prepare({
			roomId: room.id,
			requestId: "p08-check",
			artifactPaths: ["result.txt"],
			protectedPaths: [],
			checks: [
				{
					id: "accepted",
					kind: "file",
					label: "Independent artifact assertion",
					required: true,
					origin: "user",
					path: "result.txt",
					contains: "independently accepted repair",
				},
			],
		});
		f.verification.approve(draft.id, "p08-check-approved");
		const input = {
			roomId: room.id,
			content:
				"Implement module-a/readme.md and module-b/readme.md following security.md",
			intent: "execute" as const,
			mentions: [],
			verificationPlanId: draft.id,
		};
		const candidate = f.routes
			.preview(input)
			.candidates.find(
				(c) => c.workflow === "plan_execute" && c.feasible && !c.fallbackOnly,
			)!;
		expect(candidate).toBeDefined();
		const requested = { ...input, routingCandidateId: candidate.id },
			quote = f.quotes.quote(requested);
		const command = await f.commands.submit({
			...requested,
			quoteId: quote.id,
			clientRequestId: "p08-full-chain",
		});
		async function approvePlan() {
			await untilCostFlow(
				() => f.adaptive.get(command.commandId)?.status === "awaiting_plan",
				"P08 exact plan",
			);
			const child = f.adaptive.get(command.commandId)!.attempts.at(-1)!.child!,
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
		await approvePlan();
		await untilCostFlow(
			() => f.adaptive.get(command.commandId)?.status === "awaiting_approval",
			"P08 escalation approval",
		);
		const pending = f.adaptive.get(command.commandId)!;
		expect(pending.pendingApproval?.toAgentId).toBe("fixture-c");
		expect(pending.attempts).toHaveLength(2);
		expect(pending.attempts[1]!.child).toBeNull();
		expect(seen.has("fixture-model-c")).toBe(false);
		const response = await f.app.request(
			`/routing/approvals/${pending.pendingApproval!.id}/decision`,
			{
				method: "POST",
				headers: f.headers,
				body: JSON.stringify({
					requestId: "p08-escalation",
					decision: "allow",
				}),
			},
		);
		expect(response.status).toBe(202);
		await untilCostFlow(
			() => f.adaptive.get(command.commandId)!.attempts.length === 2,
			"P08 upgraded child",
		);
		// Escalation may materialize a direct host; only planned hosts need another approval.
		await untilCostFlow(
			() =>
				["awaiting_plan", "completed", "failed", "blocked"].includes(
					f.adaptive.get(command.commandId)!.status,
				),
			"P08 upgraded outcome",
		);
		if (f.adaptive.get(command.commandId)!.status === "awaiting_plan")
			await approvePlan();
		await untilCostFlow(() => {
			const v = f.adaptive.get(command.commandId)!;
			if (["failed", "blocked"].includes(v.status))
				throw new Error(
					JSON.stringify({
						v,
						tools: f.db.query("SELECT * FROM tool_calls").all(),
					}),
				);
			return v.status === "completed";
		}, "P08 complete");
		const outcome = f.adaptive.get(command.commandId)!;
		expect(outcome.outcome).toBe("verified_success");
		expect(outcome.escalations).toBe(1);
		expect(outcome.attempts[1]!.assignments.executorIds).toEqual(["fixture-c"]);
		expect(outcome.attempts[1]!.handoff?.evidenceRefs.length).toBeGreaterThan(
			0,
		);
		expect(JSON.stringify(bodies)).toContain("P08_PRIVATE_BACKGROUND");
		expect(
			f.projectMemory
				.manifests(room.id, command.commandId)
				.some((m) =>
					m.selected.some((s: { id: string }) => s.id === memory.id),
				),
		).toBe(true);
		const invocations = f.broker.ledger.list({ rootTaskId: command.commandId });
		expect(invocations.some((i) => i.purpose === "plan")).toBe(true);
		expect(
			invocations.some(
				(i) => i.agentId === "fixture-c" && i.purpose === "execute",
			),
		).toBe(true);
		expect(
			invocations.every((i) => i.priceSnapshotId && i.state === "finished"),
		).toBe(true);
		const recorder = new FlightRecorderService(f.db);
		try {
			const bundle = recorder.diagnostics(room.id, command.commandId);
			for (const source of ["route", "attempt", "invocation", "evidence"])
				expect(bundle.records.some((r) => r.source === source)).toBe(true);
			expect(
				bundle.records.filter((r) => r.source === "invocation"),
			).toHaveLength(invocations.length);
			expect(
				bundle.records.some(
					(r) => r.source === "evidence" && r.fields.status === "failed",
				),
			).toBe(true);
			expect(
				bundle.records.some(
					(r) => r.source === "evidence" && r.fields.status === "passed",
				),
			).toBe(true);
			expect(
				bundle.records.some(
					(r) => typeof r.fields.artifactSnapshotHash === "string",
				),
			).toBe(true);
			expect(JSON.stringify(bundle)).not.toContain("P08_PRIVATE_BACKGROUND");
			expect(recorder.importPreview(bundle).readOnly).toBe(true);
			const total = f.broker.ledger.summary({ rootTaskId: command.commandId })
				.totals[0]!;
			expect(
				bundle.cost.stages
					.filter((s) => s.currency === total.currency)
					.reduce((n, s) => n + BigInt(s.knownAtomic), 0n)
					.toString(),
			).toBe(total.atomic);
		} finally {
			await recorder.shutdown();
		}
	} finally {
		await f.close();
	}
}, 30000);

test("P08 Arena admission switch blocks only new experiments and preserves prepared task execution", async () => {
	const { ArenaService } = await import("./arena-service");
	const f = await setupCostFlowFixture({ routingFixture: true });
	const service = new ArenaService(f.db, {
		...f,
		baseDirectory: join(f.directory, "arena"),
		controlled: true,
	});
	const previous = process.env.SOCRATES_ARENA_ADMISSION_ENABLED;
	try {
		delete process.env.SOCRATES_ARENA_ADMISSION_ENABLED;
		const room = f.sessions.get(f.roomIds.work)!,
			collaboration = structuredClone(room.collaboration);
		collaboration.strategy = "single";
		collaboration.assignment.routing.mode = "manual";
		collaboration.assignment.routing.lightweightAgentId = "fixture-a";
		const input = {
			schemaVersion: 1,
			roomId: room.id,
			requestId: "p08-arena-admission",
			label: "Admission fixture",
			datasetVersion: "p08",
			files: ["context.txt"],
			tasks: [
				{
					id: "task",
					category: "fix",
					prompt: "Write result",
					checks: [
						{
							id: "result",
							kind: "file",
							path: "result.txt",
							label: "Result exists",
							required: true,
							origin: "user",
						},
					],
					artifactPaths: ["result.txt"],
					protectedPaths: [],
				},
			],
			variants: [
				{ id: "A", label: "A", primaryAgentId: "fixture-a", collaboration },
			],
			repeats: 1,
			concurrency: 1,
			timeoutMs: 10000,
			groupBudgetAtomic: "1000000000000000",
			trialBudgetAtomic: "1000000000000000",
			mode: "controlled",
			authorizeLive: false,
			acknowledgeSnapshot: true,
		};
		const e = service.prepare(input);
		process.env.SOCRATES_ARENA_ADMISSION_ENABLED = "false";
		expect(() =>
			service.prepare({ ...input, requestId: "blocked-new" }),
		).toThrow("arena_admission_disabled");
		expect(service.prepare(input).id).toBe(e.id);
		service.start(e.id);
		await service.wait(e.id);
		expect(service.results(e.id).trials[0]!.outcome).toBe("verified_success");
		expect(service.list(room.id)).toHaveLength(1);
	} finally {
		if (previous === undefined)
			delete process.env.SOCRATES_ARENA_ADMISSION_ENABLED;
		else process.env.SOCRATES_ARENA_ADMISSION_ENABLED = previous;
		await service.shutdown();
		await f.close();
	}
});

test("S07 real task rewind retains charged calls and does not restart a completed command", async () => {
	const f = await setupCostFlowFixture({ routingFixture: true });
	try {
		const room = f.sessions.get(f.roomIds.work)!;
		f.sessions.updateCollaboration(room.id, {
			...room.collaboration,
			strategy: "single",
		});
		const draft = f.verification.prepare({
			roomId: room.id,
			requestId: "rewind-check",
			artifactPaths: ["result.txt"],
			protectedPaths: [],
			checks: [
				{
					id: "result",
					kind: "file",
					path: "result.txt",
					label: "Independent check",
					required: true,
					origin: "user",
				},
			],
		});
		f.verification.approve(draft.id, "rewind-approved");
		const command = await f.commands.submit({
			roomId: room.id,
			content: "Write controlled result",
			intent: "execute",
			mentions: [],
			verificationPlanId: draft.id,
			clientRequestId: "rewind-command",
		});
		await untilCostFlow(
			() => f.commands.get(command.commandId)?.status === "completed",
			"rewind completed",
		);
		const before = f.broker.ledger.summary({ rootTaskId: command.commandId }),
			calls = f.nativeCalls.length;
		expect(before.invocations).toBeGreaterThan(0);
		expect(
			f.verification.view({ roomId: room.id, rootTaskId: command.commandId })
				.outcome,
		).toBe("verified_success");
		await f.sessions.rewind(room.id, f.sessions.listMessages(room.id)[0]!.id);
		expect(f.broker.ledger.summary({ rootTaskId: command.commandId })).toEqual(
			before,
		);
		expect(f.commands.get(command.commandId)?.status).toBe("revoked");
		expect(f.nativeCalls.length).toBe(calls);
		writeFileSync(
			join(f.workspace.canonicalPath, "result.txt"),
			"post-rewind changed artifact",
		);
		expect(() =>
			f.verification.view({ roomId: room.id, rootTaskId: command.commandId }),
		).toThrow("verification_target_not_found");
	} finally {
		await f.close();
	}
});

test("S03 Quality strict budget pauses the actual reviewer and resumes without rewriting worker output", async () => {
	const priorFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		throw Error("p08_external_network_forbidden");
	}) as unknown as typeof fetch;
	const f = await setupCostFlowFixture({
		routingFixture: true,
		strictBoundFixture: true,
	});
	try {
		const room = f.sessions.get(f.roomIds.work)!;
		f.sessions.updateCollaboration(room.id, {
			...room.collaboration,
			strategy: "adaptive",
			planConfirmation: {
				...room.collaboration.planConfirmation,
				reviewerAgentId: "fixture-c",
			},
			assignment: {
				...room.collaboration.assignment,
				routing: {
					...room.collaboration.assignment.routing,
					automaticPolicy: "quality",
				},
			},
		});
		writeFileSync(
			join(f.workspace.canonicalPath, "security.md"),
			"controlled review scope",
		);
		const draft = f.verification.prepare({
			roomId: room.id,
			requestId: "strict-review-check",
			artifactPaths: ["result.txt"],
			protectedPaths: [],
			checks: [
				{
					id: "exists",
					kind: "file",
					path: "result.txt",
					label: "Machine check",
					required: true,
					origin: "user",
				},
			],
		});
		f.verification.approve(draft.id, "strict-review-approve");
		const base = {
			roomId: room.id,
			content: "Deliver security.md review",
			intent: "execute" as const,
			mentions: [],
			maxOutputTokens: 256,
			verificationPlanId: draft.id,
			budget: {
				mode: "strict_admission" as const,
				limitAtomic: "200000000000",
			},
		};
		const preview = f.routes.preview(base),
			candidate = preview.candidates.find(
				(c) =>
					c.workflow === "execute_review" &&
					c.assignments.reviewerId === "fixture-c" &&
					c.assignments.executorIds[0] === "fixture-a" &&
					c.feasible,
			)!;
		expect(candidate).toBeDefined();
		const input = { ...base, routingCandidateId: candidate.id },
			quote = f.quotes.quote(input);
		const command = await f.commands.submit({
			...input,
			quoteId: quote.id,
			clientRequestId: "strict-quality-review",
		});
		await untilCostFlow(
			() => f.adaptive.get(command.commandId)?.status === "awaiting_plan",
			"strict plan",
		);
		const child = f.adaptive.get(command.commandId)!.attempts[0]!.child!,
			plan = f.tasks.getPlan(child.id)!;
		expect(
			(
				await f.app.request(`/multi/tasks/${child.id}/plan-decisions`, {
					method: "POST",
					headers: f.headers,
					body: JSON.stringify({
						version: plan.version,
						hash: plan.contentHash,
						decision: "approve_exact_plan",
						clientDecisionKey: "strict-approve",
					}),
				})
			).status,
		).toBe(200);
		await untilCostFlow(
			() => f.adaptive.get(command.commandId)?.status === "paused_budget",
			"strict reviewer pause",
		);
		expect(f.adaptive.get(command.commandId)?.preset).toBe("quality");
		expect(f.broker.budgets.get(command.commandId)?.mode).toBe(
			"strict_admission",
		);
		expect(
			f.broker.budgets.latestBlocked(command.commandId)?.details.purpose,
		).toBe("review");
		expect(
			f.verification.view({
				roomId: room.id,
				rootTaskId: command.commandId,
				workPackageId: f.packages.list(child.id)[0]!.id,
			}).outcome,
		).toBe("verified_success");
		expect(f.gatewayCalls.filter((c) => c.purpose === "review")).toHaveLength(
			0,
		);
		expect(
			f.db
				.query(
					"SELECT count(*) n FROM tool_calls WHERE name='write_file' AND status='succeeded'",
				)
				.get(),
		).toEqual({ n: 1 });
		expect(
			readFileSync(join(f.workspace.canonicalPath, "result.txt"), "utf8"),
		).toContain("Written once");
		expect(
			f.broker.ledger
				.list({ rootTaskId: command.commandId })
				.filter((i) => i.state === "finished")
				.every((i) => i.agentId === "fixture-a"),
		).toBe(true);
		const account = f.broker.budgets.get(command.commandId)!;
		f.broker.budgets.increase(command.commandId, {
			requestId: "strict-topup",
			expectedRevision: account.revision,
			amountAtomic: "2000000000000",
		});
		await f.adaptive.resume(command.commandId, "strict-resume");
		await untilCostFlow(
			() => f.adaptive.get(command.commandId)?.status === "completed",
			"strict resumed reviewer",
		);
		expect(f.adaptive.get(command.commandId)?.outcome).toBe("verified_success");
		expect(
			f.gatewayCalls
				.filter((c) => c.purpose === "review")
				.map((c) => c.agentId),
		).toEqual(["fixture-c"]);
		expect(
			f.db
				.query(
					"SELECT count(*) n FROM tool_calls WHERE name='write_file' AND status='succeeded'",
				)
				.get(),
		).toEqual({ n: 1 });
	} finally {
		await f.close();
		globalThis.fetch = priorFetch;
	}
}, 20000);
