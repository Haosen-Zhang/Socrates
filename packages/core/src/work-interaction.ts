import type { RoomCommandInput, RoomMention } from './room-command';
export const LEADER_LIMITS = { maxEvaluations: 4, maxDelegations: 2, maxOutputTokens: 1024, maxContextCharacters: 24000, maxDurationMs: 60000 } as const;
export interface WorkInteractionInput extends Partial<Pick<RoomCommandInput,'intent'|'attachmentIds'|'workspaceRefIds'|'verificationPlanId'|'routingCandidateId'|'maxOutputTokens'>> {
 clientRequestId:string; action:'message'|'note'|'request_human_review'|'reevaluate'|'delegate_package'; content:string;
 mentions:RoomMention[]; delivery?:'now'|'queue'|'stop_restart'; packageId?:string; quoteId?:string; budget?:RoomCommandInput['budget'];
}
export interface TriggerPreview {
 targets:Array<{agentId:string;label:string;reason:string;alreadyQueued:boolean;blockedReason?:string}>; createsRun:boolean; canSubmit:boolean; delivery:'now'|'queue'|'stop_restart'; activeCommandId?:string; supportsInRun:false;
 agentIds:string[]; rule:string; changesOwner:false; queued:boolean; available:boolean; reasons:string[];
 roomId:string|null; workItemId:string|null; inRunInjection:{supported:false;reason:string}; limits:typeof LEADER_LIMITS;
}
export interface WorkInteraction {
 id:string; workItemId:string|null; roomId:string|null; input:WorkInteractionInput;
 status:'queued'|'dispatching'|'dispatched'|'saved'|'awaiting_review'|'resolved'|'blocked'|'failed'|'no_action';
 commandId:string|null; evaluationId?:string; reason:string|null; createdAt:string; updatedAt:string;
}
export interface InboxLink { workspaceId:string|null; rootTaskId?:string; workItemId?:string; roomId?:string; commandId?:string; taskId?:string; packageId?:string; runId?:string; approvalId?:string; interactionId?:string; evaluationId?:string; toolOperationId?:string }
export interface InboxItem { id:string; kind:'approval'|'verification'|'unknown_side_effect'|'budget'|'blocked'|'human_review'; title:string; reason:string; link:InboxLink; revision:number; unread:boolean }
export interface InboxNotification { id:string; itemId:string; revision:number; kind:string; createdAt:string }
