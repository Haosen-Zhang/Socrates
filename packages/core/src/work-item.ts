import type { SessionMessage } from './conversation';
import type { WorkPackageDefinition, WorkPackageState } from './work-package';
import type { ToolApprovalPolicy } from './permissions';
export type WorkItemOwnerKind = 'user' | 'agent' | 'squad';
export interface WorkItem {
  id: string; workspaceId: string; roomId: string | null; sourceMessageId: string | null;
  title: string; objective: string; acceptanceCriteria: string[]; ownerKind: WorkItemOwnerKind; ownerId: string | null;
  priority: 'low' | 'normal' | 'high'; workflow: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'done';
  reviewState: 'pending' | 'accepted' | 'changes_requested'; revision: number; createdAt: string; updatedAt: string;
  messages: SessionMessage[]; workPackages: Array<WorkPackageDefinition & {verificationTarget?:import("./verification").VerificationTarget;taskId:string;state:WorkPackageState;result:string|null}>; reviews: Array<{id:string;decision:'accept'|'request_changes';createdAt:string;runId:string|null}>; artifacts: Array<{id:string;roomId:string;path:string;mediaType:string}>;
  runs: WorkItemRun[]; currentRun: WorkItemRun | null; waitReason: string | null;
}
export interface WorkItemRun { id: string; clientRequestId: string; commandId: string | null; executionRoomId: string | null; frozenOwner: unknown; state: 'preparing' | 'dispatched'; commandStatus: string | null; commandError?: string | null; createdAt: string }

export interface WorkItemPreview {
 verificationPlanId?:string;
 routing?:{preset:string;workflow:string|null;agentIds:string[];reasonCodes:string[]};
 id:string;workItemId:string;expectedRevision:number;ownerKind:WorkItemOwnerKind;ownerId:string|null;
 executionRoomId:string;executorAgentId:string;workspaceId:string;workspaceIdentityHash:string;workspacePath:string;approvalPolicy:ToolApprovalPolicy;
 quote:{id:string;roomId:string;expiresAt:string;lowAtomic:string|null;highAtomic:string|null;currency:"USD";unknowns:string[];stages:Array<{stage:string;lowAtomic:string|null;highAtomic:string|null;assumptions:string[]}>};
 canStart:boolean;reason?:string;
}
