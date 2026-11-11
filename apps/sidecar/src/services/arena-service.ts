import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	writeFileSync,
	rmSync,
	realpathSync,
	existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
	ArenaDefinition,
	ArenaExperiment,
	ArenaTrial,
} from "../../../../packages/core/src/arena";
import { arenaMetrics } from "../../../../packages/core/src/arena";
import type { TaskQuoteService } from "./task-quotes";
import {
	normalizeCollaborationSettings,
	validateCollaborationSettings,
} from "@socrates/core";
import type { RoomCommandService } from "./room-command-service";
import type { SessionStore } from "../store/session-store";
import type { WorkspaceManager } from "../workspace/manager";
import type { VerificationService } from "./verification-service";
import {
	WorkspacePathPolicy,
	isSecretWorkspacePath,
} from "../workspace/path-policy";
import { ProjectMemoryService } from "./project-memory";
import { arenaTiming } from "./arena-timing";
import { BudgetLedger, CostLedger } from "./cost-ledger";
const digest = (x: unknown) =>
	createHash("sha256").update(JSON.stringify(x)).digest("hex");
const definition = z.object({
	schemaVersion: z.literal(1),
	roomId: z.string().min(1),
	requestId: z.string().min(1).max(200),
	label: z.string().min(1).max(200),
	datasetVersion: z.string().min(1).max(100),
	files: z.array(z.string().min(1).max(500)).max(100),
	tasks: z
		.array(
			z.object({
				id: z.string().min(1),
				category: z.string().min(1),
				prompt: z.string().min(1).max(30000),
				checks: z.array(z.unknown()).min(1).max(30),
				artifactPaths: z.array(z.string()),
				protectedPaths: z.array(z.string()),
			}),
		)
		.min(1)
		.max(20),
	variants: z
		.array(
			z.object({
				id: z.string().min(1),
				label: z.string().min(1),
				primaryAgentId: z.string().min(1),
				collaboration: z.unknown(),
			}),
		)
		.min(1)
		.max(5),
	repeats: z.number().int().min(1).max(10),
	concurrency: z.number().int().min(1).max(4),
	timeoutMs: z.number().int().min(1000).max(3600000),
	groupBudgetAtomic: z.string().regex(/^[1-9]\d{0,18}$/),
	trialBudgetAtomic: z.string().regex(/^[1-9]\d{0,18}$/),
	mode: z.enum(["controlled", "live"]),
	acknowledgeSnapshot: z.literal(true),
	authorizeLive: z.boolean(),
	budgetMode: z.enum(["strict_admission", "soft_limit"]).default("soft_limit"),
	expectedSnapshotHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	memoryEntryIds: z.array(z.string()).max(100).optional(),
});
type Dependencies = {
	sessions: SessionStore;
	workspaces: WorkspaceManager;
	commands: RoomCommandService;
	verification: VerificationService;
	quotes: TaskQuoteService;
	baseDirectory: string;
	controlled?: boolean;
};
/** Persistent experiment owner; execution/verification/accounting remain the existing services. */
export class ArenaService {
	private active = new Map<string, Promise<void>>();
	constructor(
		private db: Database,
		private deps: Dependencies,
	) {}
	templates(roomId: string) {
		const room = this.deps.sessions.get(roomId);
		if (!room || room.kind !== "cowork")
			throw new Error("arena_work_room_required");
		return {
			members: room.agents.map((a) => ({
				id: a.agentId,
				label: String(a.snapshot.nickname ?? a.agentId),
			})),
			collaboration: room.collaboration,
			controlledAvailable: Boolean(this.deps.controlled),
		};
	}
	list(roomId: string) {
		return this.db
			.query<{ id: string }, [string]>(
				"SELECT id FROM arena_experiments WHERE room_id=? ORDER BY rowid DESC LIMIT 100",
			)
			.all(roomId)
			.map((x) => this.results(x.id));
	}
	view(id: string): ArenaExperiment {
		const row = this.db
			.query<{ experiment_json: string }, [string]>(
				"SELECT experiment_json FROM arena_experiments WHERE id=?",
			)
			.get(id);
		if (!row) throw new Error("arena_not_found");
		const experiment = JSON.parse(row.experiment_json) as ArenaExperiment;
		experiment.trials = this.db
			.query<{ trial_json: string }, [string]>(
				"SELECT trial_json FROM arena_trials WHERE experiment_id=? ORDER BY rowid",
			)
			.all(id)
			.map((r) => JSON.parse(r.trial_json));
		return experiment;
	}
	private save(experiment: ArenaExperiment) {
		const { trials: _trials, ...body } = experiment;
		this.db
			.query("UPDATE arena_experiments SET experiment_json=? WHERE id=?")
			.run(JSON.stringify({ ...body, trials: [] }), experiment.id);
	}
	private saveTrial(t: ArenaTrial) {
		this.db
			.query("UPDATE arena_trials SET trial_json=? WHERE id=?")
			.run(JSON.stringify(t), t.id);
	}
	prepare(raw: unknown): ArenaExperiment {
		const input = definition.parse(raw) as ArenaDefinition,
			requestHash = digest(definition.parse(raw));
		if (Buffer.byteLength(JSON.stringify(raw)) > 256000)
			throw new Error("arena_definition_too_large");
		if (input.mode === "controlled" && !this.deps.controlled)
			throw new Error("arena_controlled_transport_unavailable");
		if (input.mode === "live" && !input.authorizeLive)
			throw new Error("arena_live_authorization_required");
		const prior = this.db
			.query<{ id: string; definition_hash: string }, [string, string]>(
				"SELECT id,definition_hash FROM arena_experiments WHERE room_id=? AND request_id=?",
			)
			.get(input.roomId, input.requestId);
		if (prior) {
			if (prior.definition_hash !== requestHash)
				throw new Error("arena_request_conflict");
			return this.view(prior.id);
		}
		if (process.env.SOCRATES_ARENA_ADMISSION_ENABLED === "false")
			throw new Error("arena_admission_disabled");
		const source = this.deps.sessions.get(input.roomId);
		if (
			!source ||
			source.kind !== "cowork" ||
			!source.workspaceId ||
			source.archived
		)
			throw new Error("arena_work_room_required");
		for (const variant of input.variants) {
			variant.collaboration = normalizeCollaborationSettings(
				variant.collaboration,
			);
			const errors = validateCollaborationSettings(
				{
					kind: "cowork",
					workspaceId: source.workspaceId,
					agentIds: source.agents.map((a) => a.agentId),
					primaryAgentId: variant.primaryAgentId,
				},
				variant.collaboration,
			);
			if (errors.length) throw new Error(errors[0]);
			if (
				!source.agents.some(
					(a) => a.agentId === variant.primaryAgentId && a.executionEligible,
				)
			)
				throw new Error("arena_member_unavailable");
		}
		for (const list of [input.tasks, input.variants])
			if (new Set(list.map((t) => t.id)).size !== list.length)
				throw new Error("arena_duplicate_id");
		const policy = new WorkspacePathPolicy(
			this.deps.workspaces.get(source.workspaceId)!.canonicalPath,
		);
		const files: Record<string, string> = {};
		let bytes = 0;
		for (const path of input.files) {
			if (isSecretWorkspacePath(path) || /(^|\/)\.env(?:\.|$)/i.test(path))
				throw new Error("arena_secret_excluded");
			const snapshot = policy.snapshotTree(path, {
				maxEntries: 1,
				maxBytes: 1024 * 1024,
			});
			if (snapshot.kind !== "file")
				throw new Error("arena_explicit_files_only");
			const entry = snapshot.entries[0];
			if (entry?.kind !== "file") throw new Error("arena_file_required");
			bytes += entry.bytes.length;
			if (bytes > 8 * 1024 * 1024) throw new Error("arena_snapshot_too_large");
			files[policy.resolveExisting(path).relativePath] =
				entry.bytes.toString("base64");
		}
		const memory = new ProjectMemoryService(this.db),
			memorySnapshot = memory.captureArenaMemory(
				source.id,
				input.memoryEntryIds ?? [],
			);
		const count = input.tasks.length * input.variants.length * input.repeats;
		const used = this.db
			.query<{ experiment_json: string }, []>(
				"SELECT experiment_json FROM arena_experiments",
			)
			.all()
			.reduce((n, r) => {
				const e = JSON.parse(r.experiment_json);
				return (
					n +
					(e.artifactsExpiredAt
						? 0
						: (e.sourceBytes ?? 0) *
							e.definition.tasks.length *
							e.definition.variants.length *
							e.definition.repeats)
				);
			}, 0);
		if (
			count > 100 ||
			bytes * count > 256 * 1024 * 1024 ||
			used + bytes * count > 512 * 1024 * 1024
		)
			throw new Error("arena_disk_quota_exceeded");
		const id = crypto.randomUUID(),
			snapshotHash = digest(files),
			createdAt = new Date().toISOString();
		if (
			input.expectedSnapshotHash &&
			input.expectedSnapshotHash !== snapshotHash
		)
			throw new Error("arena_start_snapshot_changed");
		const experiment: ArenaExperiment = {
			id,
			sourceWorkspaceId: source.workspaceId,
			definition: input,
			snapshotHash,
			status: "prepared",
			createdAt,
			sourceBytes: bytes,
			preparationComplete: false,
			trials: [],
			evaluatorVersion: "socrates-verification-v1",
			memoryPolicy: memorySnapshot.length
				? "frozen-selected"
				: "isolated-empty",
			cachePolicy: "provider-observed-not-controlled",
		};
		this.db
			.query("INSERT INTO arena_experiments VALUES (?,?,?,?,?,?)")
			.run(
				id,
				input.roomId,
				input.requestId,
				requestHash,
				JSON.stringify(experiment),
				JSON.stringify({ files, memorySnapshot }),
			);
		new BudgetLedger(this.db).create({
			rootTaskId: id,
			roomId: source.id,
			mode: input.budgetMode ?? "soft_limit",
			limitAtomic: input.groupBudgetAtomic,
		});
		const createdRooms: string[] = [],
			createdWorkspaces: Array<{ id: string; path: string }> = [];
		try {
			for (let repeat = 0; repeat < input.repeats; repeat++)
				for (const task of input.tasks)
					for (const variant of input.variants) {
						if (
							!source.agents.some(
								(a) =>
									a.agentId === variant.primaryAgentId && a.executionEligible,
							)
						)
							throw new Error("arena_member_unavailable");
						const trialId = crypto.randomUUID(),
							path = join(this.deps.baseDirectory, id, trialId);
						mkdirSync(path, { recursive: true });
						for (const [file, content] of Object.entries(files)) {
							const destination = join(path, file);
							mkdirSync(dirname(destination), { recursive: true });
							writeFileSync(destination, Buffer.from(content, "base64"), {
								flag: "wx",
							});
						}
						const workspace = this.deps.workspaces.select(path);
						createdWorkspaces.push({ id: workspace.id, path });
						const room = this.deps.sessions.create({
							title: `Arena · ${variant.label}`,
							mode: source.agents.length > 1 ? "multi_agent" : "single_agent",
							kind: "cowork",
							workspaceId: workspace.id,
							primaryAgentId: variant.primaryAgentId,
							collaborationDefaults: variant.collaboration,
							agents: source.agents,
						});
						createdRooms.push(room.id);
						this.deps.sessions.updateApprovalPolicy(
							room.id,
							source.approvalPolicy.mode,
						);
						const trial: ArenaTrial = {
							id: trialId,
							experimentId: id,
							taskId: task.id,
							variantId: variant.id,
							repeat,
							roomId: room.id,
							workspaceId: workspace.id,
							status: "planned",
							knownAtomic: "0",
							estimatedAtomic: "0",
							unknownCount: 0,
							snapshotHash,
						};
						this.db
							.query("INSERT INTO arena_trials VALUES (?,?,?,?)")
							.run(trial.id, id, room.id, JSON.stringify(trial));
						memory.installArenaMemory(room.id, memorySnapshot);
						const plan = this.deps.verification.prepare({
							roomId: room.id,
							requestId: `arena:${trialId}`,
							checks: task.checks,
							artifactPaths: task.artifactPaths,
							protectedPaths: task.protectedPaths,
							source: "user",
						});
						this.deps.verification.approve(
							plan.id,
							`arena-approved:${trialId}`,
						);
						trial.planId = plan.id;
						try {
							const quote = this.deps.quotes.quote({
								roomId: room.id,
								content: task.prompt,
								intent: "execute",
								mentions: [],
								verificationPlanId: plan.id,
								budget: {
									mode: input.budgetMode ?? "soft_limit",
									limitAtomic: input.trialBudgetAtomic,
								},
							});
							trial.quote = {
								id: quote.id,
								lowAtomic: quote.lowAtomic,
								highAtomic: quote.highAtomic,
								expiresAt: quote.expiresAt,
								priceSnapshotIds: quote.priceSnapshotIds,
							};
						} catch (error) {
							trial.status = "failed";
							trial.reason =
								error instanceof Error
									? error.message
									: "arena_preflight_failed";
							trial.outcome = "blocked";
							trial.finishedAt = new Date().toISOString();
						}
						this.saveTrial(trial);
					}
			experiment.preparationComplete = true;
			this.save(experiment);
			return this.view(id);
		} catch (error) {
			for (const trial of this.view(id).trials) {
				trial.status = "failed";
				this.saveTrial(trial);
				memory.discardArenaMemory(trial.roomId);
			}
			this.db.query("DELETE FROM arena_trials WHERE experiment_id=?").run(id);
			// These rooms are newly created and have never dispatched; remove their roster before the room FK.
			for (const roomId of createdRooms) {
				this.db.query("DELETE FROM cost_quotes WHERE room_id=?").run(roomId);
				this.db
					.query("DELETE FROM session_agents WHERE session_id=?")
					.run(roomId);
				this.db.query("DELETE FROM sessions WHERE id=?").run(roomId);
			}
			for (const workspace of createdWorkspaces) {
				this.db.query("DELETE FROM workspaces WHERE id=?").run(workspace.id);
				rmSync(workspace.path, { recursive: true, force: true });
			}
			this.db
				.query("DELETE FROM cost_budget_accounts WHERE root_task_id=?")
				.run(id);
			this.db.query("DELETE FROM arena_experiments WHERE id=?").run(id);
			throw error;
		}
	}
	start(id: string): ArenaExperiment {
		const e = this.view(id);
		if (!e.preparationComplete)
			throw new Error("arena_preparation_interrupted");
		if (e.artifactsExpiredAt) throw new Error("arena_artifacts_expired");
		if (["cancelled", "completed"].includes(e.status)) return e;
		if (this.active.has(id)) return e;
		e.status = "running";
		this.save(e);
		const run = this.run(id).finally(() => this.active.delete(id));
		this.active.set(id, run);
		void run.catch(() => {
			const failed = this.view(id);
			failed.status = "paused";
			this.save(failed);
		});
		return this.view(id);
	}
	async wait(id: string) {
		await this.active.get(id);
	}
	private async run(id: string) {
		const e = this.view(id);
		let index = 0;
		const queued = e.trials.filter((t) =>
			["planned", "waiting", "interrupted"].includes(t.status),
		);
		for (const trial of queued) {
			trial.queuedAt ??= new Date().toISOString();
			this.saveTrial(trial);
		}
		await Promise.all(
			Array.from({ length: e.definition.concurrency }, async () => {
				while (index < queued.length) {
					if (this.view(id).status !== "running") return;
					const trial = queued[index++]!;
					await this.provider(id, trial.id).callApi(
						e.definition.tasks.find((t) => t.id === trial.taskId)!.prompt,
					);
				}
			}),
		);
		const current = this.view(id);
		if (current.status === "running") {
			current.status = current.trials.some((t) =>
				["waiting", "interrupted", "planned", "running"].includes(t.status),
			)
				? "paused"
				: "completed";
			this.save(current);
		}
	}
	provider(id: string, trialId: string) {
		return new ArenaTaskProvider(trialId, async (prompt) => {
			const e = this.view(id),
				trial = e.trials.find((t) => t.id === trialId);
			if (!trial) throw new Error("arena_trial_not_found");
			if (
				e.definition.tasks.find((t) => t.id === trial.taskId)!.prompt !== prompt
			)
				throw new Error("arena_prompt_mismatch");
			if (!["completed", "failed", "cancelled"].includes(trial.status))
				await this.execute(e, trial);
			const result = this.view(id).trials.find((t) => t.id === trialId)!;
			return {
				output: JSON.stringify(result),
				metadata: { ...result, scope: "whole_socrates_task" },
			};
		});
	}
	private async execute(e: ArenaExperiment, trial: ArenaTrial) {
		trial.status = "running";
		trial.startedAt ??= new Date().toISOString();
		this.saveTrial(trial);
		try {
			const task = e.definition.tasks.find((t) => t.id === trial.taskId)!;
			const plan = this.deps.verification.prepare({
				roomId: trial.roomId,
				requestId: `arena:${trial.id}`,
				checks: task.checks,
				artifactPaths: task.artifactPaths,
				protectedPaths: task.protectedPaths,
				source: "user",
			});
			this.deps.verification.approve(plan.id, `arena-approved:${trial.id}`);
			const input = {
				roomId: trial.roomId,
				content: task.prompt,
				intent: "execute" as const,
				mentions: [],
				verificationPlanId: plan.id,
				budget: {
					mode: e.definition.budgetMode ?? "soft_limit",
					limitAtomic: e.definition.trialBudgetAtomic,
				},
			};
			const existing = this.deps.commands.list(trial.roomId)[0];
			let quote = trial.quote;
			if (!quote) throw new Error("arena_preflight_quote_missing");
			if (!existing && Date.parse(quote.expiresAt) <= Date.now()) {
				const previous = this.deps.quotes.get(quote.id),
					fresh = this.deps.quotes.quote(input);
				if (!previous || previous.inputHash !== fresh.inputHash)
					throw new Error("arena_preflight_configuration_changed");
				trial.quote = {
					id: fresh.id,
					lowAtomic: fresh.lowAtomic,
					highAtomic: fresh.highAtomic,
					expiresAt: fresh.expiresAt,
					priceSnapshotIds: fresh.priceSnapshotIds,
				};
				quote = trial.quote;
				this.saveTrial(trial);
			}
			const command =
				existing ??
				(await this.deps.commands.submit({
					...input,
					clientRequestId: `arena:${trial.id}`,
					quoteId: quote!.id,
				}));
			trial.commandId = command.commandId;
			this.saveTrial(trial);
			const deadline = Date.parse(trial.startedAt!) + e.definition.timeoutMs;
			while (Date.now() < deadline) {
				const command = this.deps.commands.get(trial.commandId!);
				if (!command) throw new Error("arena_command_missing");
				if (
					["completed", "failed", "cancelled", "revoked"].includes(
						command.status,
					)
				) {
					trial.status =
						command.status === "completed"
							? "completed"
							: command.status === "cancelled"
								? "cancelled"
								: "failed";
					trial.reason = command.error;
					break;
				}
				if (
					this.db
						.query(
							"SELECT id FROM approval_requests WHERE session_id=? AND status='pending' LIMIT 1",
						)
						.get(trial.roomId)
				) {
					trial.status = "waiting";
					trial.reason = "tool_approval_required";
					break;
				}
				if (command.status !== "running" && command.status !== "dispatching") {
					trial.status = "waiting";
					trial.reason = command.error ?? command.status;
					break;
				}
				if (this.view(e.id).status === "paused") {
					trial.status = "interrupted";
					trial.reason = "experiment_paused";
					break;
				}
				if (this.view(e.id).status === "cancelled") {
					await this.deps.commands.cancel(trial.commandId!);
					trial.status = "cancelled";
					break;
				}
				await Bun.sleep(50);
			}
			if (trial.status === "running") {
				await this.deps.commands.cancel(trial.commandId!);
				trial.status = "failed";
				trial.reason = "arena_timeout";
			}
			const result = this.deps.verification.view({
				roomId: trial.roomId,
				rootTaskId: trial.commandId!,
			});
			trial.outcome = result.outcome;
			if (["completed", "failed", "cancelled"].includes(trial.status))
				trial.completionOutcome ??= result.outcome;
		} catch (error) {
			trial.status = "failed";
			trial.reason = error instanceof Error ? error.message : "arena_failed";
		}
		trial.commandId ??= this.view(e.id).trials.find(
			(t) => t.id === trial.id,
		)?.commandId;
		if (trial.commandId) {
			const cost = new CostLedger(this.db).summary({
				rootTaskId: trial.commandId,
			});
			trial.knownAtomic = cost.totals
				.filter((x) => x.currency === "USD")
				.reduce((n, x) => n + BigInt(x.atomic), 0n)
				.toString();
			trial.estimatedAtomic = (cost.estimatedTotals ?? [])
				.filter((x) => x.currency === "USD")
				.reduce((n, x) => n + BigInt(x.atomic), 0n)
				.toString();
			trial.unknownCount =
				cost.unknownCount +
				cost.totals.filter((x) => x.currency !== "USD").length;
		}
		if (["completed", "failed", "cancelled"].includes(trial.status))
			trial.finishedAt = new Date().toISOString();
		this.saveTrial(trial);
	}
	async cancel(id: string, trialId?: string) {
		const e = this.view(id);
		if (trialId && !e.trials.some((t) => t.id === trialId))
			throw new Error("arena_trial_not_found");
		if (e.status === "completed") return e;
		if (e.status === "cancelled") {
			await this.active.get(id);
			return this.view(id);
		}
		if (!trialId) {
			e.status = "cancelled";
			this.save(e);
		}
		for (const t of e.trials.filter((t) => !trialId || t.id === trialId)) {
			if (["completed", "failed", "cancelled"].includes(t.status)) continue;
			if (t.commandId) await this.deps.commands.cancel(t.commandId);
			t.status = "cancelled";
			t.finishedAt = new Date().toISOString();
			if (t.commandId) {
				const cost = new CostLedger(this.db).summary({
					rootTaskId: t.commandId,
				});
				t.knownAtomic = cost.totals
					.filter((x) => x.currency === "USD")
					.reduce((n, x) => n + BigInt(x.atomic), 0n)
					.toString();
				t.estimatedAtomic = (cost.estimatedTotals ?? [])
					.filter((x) => x.currency === "USD")
					.reduce((n, x) => n + BigInt(x.atomic), 0n)
					.toString();
				t.unknownCount = cost.unknownCount;
			}
			this.saveTrial(t);
		}
		if (!trialId) await this.active.get(id);
		return this.view(id);
	}
	cleanup(id: string, confirmed: boolean) {
		if (!confirmed) throw new Error("arena_cleanup_confirmation_required");
		const e = this.view(id);
		if (e.artifactsExpiredAt) return e;
		if (
			this.active.has(id) ||
			e.trials.some(
				(t) => !["completed", "failed", "cancelled"].includes(t.status),
			)
		)
			throw new Error("arena_cleanup_running");
		const root = realpathSync(this.deps.baseDirectory);
		for (const trial of e.trials) {
			const workspace = this.deps.workspaces.get(trial.workspaceId),
				room = this.deps.sessions.get(trial.roomId),
				expected = join(root, e.id, trial.id);
			if (
				!workspace ||
				workspace.canonicalPath !== expected ||
				room?.workspaceId !== trial.workspaceId
			)
				throw new Error("arena_cleanup_workspace_changed");
			if (
				this.db
					.query("SELECT id FROM workspace_leases WHERE workspace_id=?")
					.get(trial.workspaceId)
			)
				throw new Error("arena_cleanup_workspace_busy");
			if (existsSync(expected) && realpathSync(expected) !== expected)
				throw new Error("arena_cleanup_path_changed");
		}
		for (const trial of e.trials) {
			new ProjectMemoryService(this.db).discardArenaMemory(trial.roomId);
			rmSync(join(root, e.id, trial.id), { recursive: true, force: true });
			this.deps.workspaces.archive(trial.workspaceId, true);
		}
		e.artifactsExpiredAt = new Date().toISOString();
		this.save(e);
		this.db
			.query("UPDATE arena_experiments SET snapshot_json=? WHERE id=?")
			.run(
				JSON.stringify({ files: {}, memorySnapshot: [], expired: true }),
				id,
			);
		return this.view(id);
	}
	async shutdown() {
		for (const id of this.active.keys()) {
			const e = this.view(id);
			e.status = "paused";
			this.save(e);
		}
		await Promise.allSettled(this.active.values());
	}
	recover() {
		for (const row of this.db
			.query<{ id: string }, []>("SELECT id FROM arena_experiments")
			.all()) {
			const e = this.view(row.id);
			if (e.status === "running") {
				e.status = "paused";
				this.save(e);
			}
			for (const t of e.trials)
				if (t.status === "running") {
					t.status = "interrupted";
					t.reason = "restart_requires_explicit_resume";
					this.saveTrial(t);
				}
		}
	}
	results(id: string) {
		const e = this.view(id);
		for (const trial of e.trials) {
			if (!trial.commandId) continue;
			const before = JSON.stringify(trial),
				cost = new CostLedger(this.db).summary({ rootTaskId: trial.commandId });
			trial.knownAtomic = cost.totals
				.filter((x) => x.currency === "USD")
				.reduce((n, x) => n + BigInt(x.atomic), 0n)
				.toString();
			trial.estimatedAtomic = (cost.estimatedTotals ?? [])
				.filter((x) => x.currency === "USD")
				.reduce((n, x) => n + BigInt(x.atomic), 0n)
				.toString();
			trial.unknownCount =
				cost.unknownCount +
				cost.totals.filter((x) => x.currency !== "USD").length +
				(cost.estimatedTotals ?? []).filter((x) => x.currency !== "USD").length;
			try {
				trial.outcome = this.deps.verification.view({
					roomId: trial.roomId,
					rootTaskId: trial.commandId,
				}).outcome;
				trial.evidenceAvailability = e.artifactsExpiredAt
					? "expired"
					: "available";
			} catch {
				trial.outcome = "completed_unverified";
				trial.evidenceAvailability = e.artifactsExpiredAt
					? "expired"
					: "unavailable";
			}
			if (before !== JSON.stringify(trial)) this.saveTrial(trial);
		}
		return {
			...e,
			timing: e.trials.map((t) => ({
				trialId: t.id,
				...arenaTiming(this.db, t),
			})),
			replayConfiguration: {
				...e.definition,
				expectedSnapshotHash: e.snapshotHash,
			},
			metrics: arenaMetrics(e.trials),
			independentTaskCount: e.definition.tasks.length,
			byTask: e.definition.tasks.map((task) => ({
				taskId: task.id,
				category: task.category,
				variants: e.definition.variants.map((v) => ({
					variantId: v.id,
					...arenaMetrics(
						e.trials.filter(
							(t) => t.taskId === task.id && t.variantId === v.id,
						),
					),
				})),
			})),
			byVariant: e.definition.variants.map((v) => ({
				variantId: v.id,
				...arenaMetrics(e.trials.filter((t) => t.variantId === v.id)),
			})),
			strategyEvidence: {
				status: "proposal_only",
				datasetVersion: e.definition.datasetVersion,
				evaluatorVersion: e.evaluatorVersion,
				policyApplied: false,
			},
		};
	}
}
/** promptfoo custom-provider contract: dispatches an entire real task, never a bare model request. */
export class ArenaTaskProvider {
	constructor(
		private trialId: string,
		private run: (
			prompt: string,
		) => Promise<{ output: string; metadata: Record<string, unknown> }>,
	) {}
	id() {
		return `socrates:arena:${this.trialId}`;
	}
	callApi(prompt: string) {
		return this.run(prompt);
	}
}
