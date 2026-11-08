export type MemoryKind =
	| "goal"
	| "constraint"
	| "decision"
	| "fact"
	| "todo"
	| "artifact_reference";
export type MemoryStatus =
	| "proposed"
	| "confirmed"
	| "superseded"
	| "rejected"
	| "expired";
export interface MemoryEntry {
 authorizationSource?:{entryId:string;projectId:string;roomId:string;version:number};
	id: string;
	version: number;
	projectId: string;
	roomScope: string | null;
	kind: MemoryKind;
	content: string;
	status: MemoryStatus;
	origin: "user" | "agent_proposal" | "import" | "verified_artifact";
	sourceRefs: string[];
	allowedProviders: string[];
	pinned: boolean;
	expiresAt: string | null;
	relevantRevision: string | null;
	tags: string[];
	conflictsWith: string[];
	createdAt: string;
	portableSources?: Array<{ kind: string; hash: string; available: boolean }>;
	portableProvenance?: Array<{
		version: number;
		content: string;
		status: string;
		contentHash: string;
	}>;
}
export interface ContextManifest {
	id: string;
	memoryRevision: string;
	taskCursor: number;
	rootTaskId: string;
	roomId: string;
	targetProvider: string;
	selected: Array<{
		id: string;
		version: number;
		sourceRefs: string[];
		estimatedTokens: number;
		reason: string;
	}>;
	excluded: {
		sensitive: number;
		stale: number;
		conflicting: number;
		budget: number;
	};
	estimatedTokens: number;
	createdAt: string;
}
