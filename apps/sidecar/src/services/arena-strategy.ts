import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
	ArenaExperiment,
	ArenaTrial,
	RoomCollaborationSettings,
} from "@socrates/core";
import { arenaMetrics, validateCollaborationSettings } from "@socrates/core";
import type { SessionStore } from "../store/session-store";
const hash = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
type Configuration = {
	collaboration: RoomCollaborationSettings;
	primaryAgentId: string;
};
export interface StrategyPreview {
	hash: string;
	roomId: string;
	experimentId: string;
	variantId: string;
	mode: "controlled" | "live";
	interpretation:
		| "demonstration_configuration"
		| "exploratory_evidence_not_generalizable";
	eligible: boolean;
	blockers: string[];
	baselineHash: string;
	proposed: Configuration;
	metrics: ReturnType<typeof arenaMetrics>;
	evidence: {
		datasetVersion: string;
		evaluatorVersion: string;
		snapshotHash: string;
		taskCount: number;
		policyHash: string;
		models: Array<{
			agentId: string;
			providerId: unknown;
			modelId: unknown;
			profileHash: string;
		}>;
		trialIds: string[];
	};
}
interface StrategyVersion {
	id: string;
	roomId: string;
	previewHash: string;
	before: Configuration;
	after: Configuration;
	beforeHash: string;
	afterHash: string;
	createdAt: string;
}
export class ArenaStrategyService {
	constructor(
		private db: Database,
		private sessions: SessionStore,
		private refreshExperiment?: (experimentId: string) => unknown,
	) {}
	private room(roomId: string) {
		const room = this.sessions.get(roomId);
		if (!room || room.archived || room.kind !== "cowork" || !room.workspaceId)
			throw Error("arena_strategy_room_unavailable");
		return room;
	}
	private configuration(roomId: string): Configuration {
		const room = this.room(roomId);
		if (!room.primaryAgentId) throw Error("arena_strategy_primary_missing");
		return {
			collaboration: room.collaboration,
			primaryAgentId: room.primaryAgentId,
		};
	}
	private authorize(roomId: string, value: Configuration) {
		const room = this.room(roomId);
		const errors = validateCollaborationSettings(
			{
				kind: "cowork",
				workspaceId: room.workspaceId,
				agentIds: room.agents.map((a) => a.agentId),
				primaryAgentId: value.primaryAgentId,
			},
			value.collaboration,
		);
		if (errors.length) throw Error(errors[0]);
		const ids = new Set(
			[
				value.primaryAgentId,
				value.collaboration.assignment.coordinatorAgentId,
				...value.collaboration.assignment.callableAgentIds,
				...value.collaboration.discussion.speakerOrder,
				value.collaboration.discussion.summaryAgentId,
			].filter((v): v is string => !!v),
		);
		for (const id of ids) {
			const member = room.agents.find((a) => a.agentId === id);
			if (!member?.executionEligible)
				throw Error("arena_strategy_member_revoked");
			const providerId = String(member.snapshot.providerId ?? "");
			const provider = this.db
				.query<{ enabled: number }, [string]>(
					"SELECT enabled FROM providers WHERE id=?",
				)
				.get(providerId);
			if (!provider?.enabled) throw Error("arena_strategy_provider_revoked");
			const allowed = value.collaboration.assignment.routing.allowedProviderIds;
			if (allowed && !allowed.includes(providerId))
				throw Error("arena_strategy_provider_not_allowed");
		}
	}
	preview(experimentId: string, variantId: string): StrategyPreview {
		this.refreshExperiment?.(experimentId);
		const row = this.db
			.query<{ room_id: string; experiment_json: string }, [string]>(
				"SELECT room_id,experiment_json FROM arena_experiments WHERE id=?",
			)
			.get(experimentId);
		if (!row) throw Error("arena_not_found");
		const experiment = JSON.parse(row.experiment_json) as ArenaExperiment;
		const room = this.room(row.room_id);
		if (room.workspaceId !== experiment.sourceWorkspaceId)
			throw Error("arena_strategy_workspace_changed");
		const variant = experiment.definition.variants.find(
			(v) => v.id === variantId,
		);
		if (!variant) throw Error("arena_variant_not_found");
		const all = this.db
			.query<{ trial_json: string }, [string]>(
				"SELECT trial_json FROM arena_trials WHERE experiment_id=?",
			)
			.all(experimentId)
			.map((r) => JSON.parse(r.trial_json) as ArenaTrial);
		const trials = all.filter((t) => t.variantId === variantId),
			metrics = arenaMetrics(trials),
			taskCount = new Set(trials.map((t) => t.taskId)).size;
		const blockers: string[] = [];
		if (
			all.length !==
				experiment.definition.tasks.length *
					experiment.definition.variants.length *
					experiment.definition.repeats ||
			experiment.status !== "completed" ||
			all.some((t) => !["completed", "failed", "cancelled"].includes(t.status))
		)
			blockers.push("arena_strategy_incomplete");
		if (taskCount < 3) blockers.push("arena_strategy_insufficient_tasks");
		if (!metrics.verified) blockers.push("arena_strategy_no_verified_success");
		if (metrics.unknownCount) blockers.push("arena_strategy_unknown_cost");
		const proposed = {
			collaboration: variant.collaboration,
			primaryAgentId: variant.primaryAgentId,
		};
		try {
			this.authorize(room.id, proposed);
		} catch (e) {
			blockers.push((e as Error).message);
		}
		const modelMap = new Map<
			string,
			{
				agentId: string;
				providerId: unknown;
				modelId: unknown;
				profileHash: string;
			}
		>();
		for (const trial of trials) {
			const trialRoom = this.sessions.get(trial.roomId);
			for (const agent of trialRoom?.agents ?? []) {
				modelMap.set(agent.agentId, {
					agentId: agent.agentId,
					providerId: agent.snapshot.providerId,
					modelId: agent.snapshot.modelId,
					profileHash: hash(agent.snapshot),
				});
			}
		}
		for (const model of modelMap.values()) {
			const current = room.agents.find((a) => a.agentId === model.agentId);
			if (!current || hash(current.snapshot) !== model.profileHash)
				blockers.push("arena_strategy_profile_changed");
		}
		if (!modelMap.size) blockers.push("arena_strategy_profile_missing");
		const data = {
			roomId: room.id,
			experimentId,
			variantId,
			mode: experiment.definition.mode,
			interpretation:
				experiment.definition.mode === "controlled"
					? ("demonstration_configuration" as const)
					: ("exploratory_evidence_not_generalizable" as const),
			eligible: !blockers.length,
			blockers,
			baselineHash: hash(this.configuration(room.id)),
			proposed,
			metrics,
			evidence: {
				datasetVersion: experiment.definition.datasetVersion,
				evaluatorVersion: experiment.evaluatorVersion,
				snapshotHash: experiment.snapshotHash,
				taskCount,
				policyHash: hash(variant.collaboration),
				models: [...modelMap.values()],
				trialIds: trials.map((t) => t.id),
			},
		};
		const result = { ...data, hash: hash(data) };
		this.db
			.query("INSERT OR IGNORE INTO arena_strategy_previews VALUES(?,?,?)")
			.run(result.hash, room.id, JSON.stringify(result));
		return result;
	}
	apply(
		roomId: string,
		previewHash: string,
		requestId: string,
		confirmed: true,
	): StrategyVersion {
		if (confirmed !== true || !requestId || requestId.length > 200)
			throw Error("arena_strategy_confirmation_required");
		this.room(roomId);
		const existing = this.db
			.query<{ preview_hash: string; version_json: string }, [string, string]>(
				"SELECT preview_hash,version_json FROM arena_strategy_versions WHERE room_id=? AND request_id=?",
			)
			.get(roomId, requestId);
		if (existing) {
			if (existing.preview_hash !== previewHash)
				throw Error("arena_strategy_request_conflict");
			return JSON.parse(existing.version_json);
		}
		const row = this.db
			.query<{ room_id: string; preview_json: string }, [string]>(
				"SELECT room_id,preview_json FROM arena_strategy_previews WHERE hash=?",
			)
			.get(previewHash);
		if (row?.room_id !== roomId) throw Error("arena_strategy_preview_scope");
		const p = JSON.parse(row.preview_json) as StrategyPreview;
		if (!p.eligible)
			throw Error(p.blockers[0] ?? "arena_strategy_not_eligible");
		const fresh = this.preview(p.experimentId, p.variantId);
		if (fresh.hash !== p.hash) throw Error("arena_strategy_preview_stale");
		return this.db.transaction(() => {
			const before = this.configuration(roomId);
			if (hash(before) !== p.baselineHash)
				throw Error("arena_strategy_config_changed");
			this.authorize(roomId, p.proposed);
			this.sessions.updateCollaboration(
				roomId,
				p.proposed.collaboration,
				p.proposed.primaryAgentId,
			);
			const after = this.configuration(roomId);
			const result: StrategyVersion = {
				id: crypto.randomUUID(),
				roomId,
				previewHash,
				before,
				after,
				beforeHash: hash(before),
				afterHash: hash(after),
				createdAt: new Date().toISOString(),
			};
			this.db
				.query("INSERT INTO arena_strategy_versions VALUES(?,?,?,?,?)")
				.run(result.id, roomId, requestId, previewHash, JSON.stringify(result));
			return result;
		})();
	}
	rollback(roomId: string, versionId: string, requestId: string) {
		this.room(roomId);
		if (!requestId || requestId.length > 200)
			throw Error("arena_strategy_request_invalid");
		const old = this.db
			.query<{ version_id: string; result_json: string }, [string, string]>(
				"SELECT version_id,result_json FROM arena_strategy_rollbacks WHERE room_id=? AND request_id=?",
			)
			.get(roomId, requestId);
		if (old) {
			if (old.version_id !== versionId)
				throw Error("arena_strategy_request_conflict");
			return JSON.parse(old.result_json);
		}
		const row = this.db
			.query<{ room_id: string; version_json: string }, [string]>(
				"SELECT room_id,version_json FROM arena_strategy_versions WHERE id=?",
			)
			.get(versionId);
		if (row?.room_id !== roomId) throw Error("arena_strategy_version_scope");
		const version = JSON.parse(row.version_json) as StrategyVersion;
		return this.db.transaction(() => {
			if (hash(this.configuration(roomId)) !== version.afterHash)
				throw Error("arena_strategy_config_changed");
			this.authorize(roomId, version.before);
			this.sessions.updateCollaboration(
				roomId,
				version.before.collaboration,
				version.before.primaryAgentId,
			);
			const result = {
				versionId,
				rolledBack: true,
				configuration: this.configuration(roomId),
			};
			this.db
				.query("INSERT INTO arena_strategy_rollbacks VALUES(?,?,?,?)")
				.run(roomId, requestId, versionId, JSON.stringify(result));
			return result;
		})();
	}
	history(roomId: string) {
		this.room(roomId);
		return this.db
			.query<{ version_json: string }, [string]>(
				"SELECT version_json FROM arena_strategy_versions WHERE room_id=? ORDER BY rowid DESC LIMIT 100",
			)
			.all(roomId)
			.map((r) => JSON.parse(r.version_json) as StrategyVersion);
	}
}
