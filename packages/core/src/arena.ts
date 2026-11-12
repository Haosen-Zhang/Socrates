import type { RoomCollaborationSettings } from "./room-kind";
import type { VerificationCheck } from "./verification";
export interface ArenaTask {
	id: string;
	category: string;
	prompt: string;
	checks: VerificationCheck[];
	artifactPaths: string[];
	protectedPaths: string[];
}
export interface ArenaVariant {
	squadId?: string;
	squadRevision?: number;
	id: string;
	label: string;
	primaryAgentId: string;
	collaboration: RoomCollaborationSettings;
}
export interface ArenaDefinition {
	schemaVersion: 1;
	roomId: string;
	requestId: string;
	label: string;
	datasetVersion: string;
	files: string[];
	tasks: ArenaTask[];
	variants: ArenaVariant[];
	repeats: number;
	concurrency: number;
	timeoutMs: number;
	groupBudgetAtomic: string;
	trialBudgetAtomic: string;
	mode: "controlled" | "live";
	acknowledgeSnapshot: boolean;
	authorizeLive: boolean;
	budgetMode?: "strict_admission" | "soft_limit";
	expectedSnapshotHash?: string;
	memoryEntryIds?: string[];
}
export interface ArenaTrial {
	id: string;
	experimentId: string;
	taskId: string;
	variantId: string;
	repeat: number;
	roomId: string;
	workspaceId: string;
	status:
		| "planned"
		| "running"
		| "waiting"
		| "interrupted"
		| "completed"
		| "failed"
		| "cancelled";
	commandId?: string;
	outcome?: string;
	completionOutcome?: string;
	evidenceAvailability?: "available" | "expired" | "unavailable";
	reason?: string;
	queuedAt?: string;
	startedAt?: string;
	finishedAt?: string;
	knownAtomic: string;
	estimatedAtomic: string;
	unknownCount: number;
	snapshotHash: string;
	planId?: string;
	quote?: {
		id: string;
		lowAtomic: string | null;
		highAtomic: string | null;
		expiresAt: string;
		priceSnapshotIds: string[];
	};
}
export interface ArenaExperiment {
	id: string;
	sourceWorkspaceId: string;
	definition: ArenaDefinition;
	snapshotHash: string;
	status: "prepared" | "running" | "paused" | "completed" | "cancelled";
	createdAt: string;
	preparationComplete?: boolean;
	sourceBytes?: number;
	artifactsExpiredAt?: string;
	trials: ArenaTrial[];
	evaluatorVersion: string;
	memoryPolicy: "isolated-empty" | "frozen-selected";
	cachePolicy: "provider-observed-not-controlled";
}
export function arenaMetrics(trials: ArenaTrial[]) {
	const terminal = trials.filter((t) =>
		["completed", "failed", "cancelled"].includes(t.status),
	);
	const verified = trials.filter(
		(t) => t.status === "completed" && t.outcome === "verified_success",
	);
	const incomplete =
		terminal.length !== trials.length ||
		trials.some((t) => t.status === "cancelled" && !t.startedAt);
	const known = trials.reduce((n, t) => n + BigInt(t.knownAtomic), 0n),
		estimated = trials.reduce((n, t) => n + BigInt(t.estimatedAtomic), 0n);
	const unknown = trials.reduce((n, t) => n + t.unknownCount, 0);
	return {
		planned: trials.length,
		started: trials.filter((t) => t.startedAt).length,
		terminal: terminal.length,
		verified: verified.length,
		verifiedSuccessRate: trials.length ? verified.length / trials.length : null,
		knownAtomic: known.toString(),
		estimatedAtomic: estimated.toString(),
		unknownCount: unknown,
		costPerVerifiedSuccessAtomic:
			verified.length && !unknown && !estimated && !incomplete
				? (known / BigInt(verified.length)).toString()
				: null,
		incomplete,
		interpretation: "exploratory_raw_samples" as const,
	};
}
