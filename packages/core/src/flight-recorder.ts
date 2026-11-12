/** Read-only audit projection; money remains in the invocation ledger. */
export interface FlightRecord {
  id:string; sequence:number; roomId:string; rootTaskId:string; parentId:string|null;
  source:string; sourceSequence:number; stage:string; type:string; agentId:string|null;
  occurredAt:string; traceId:string; spanId:string; version:1;
  fields:Record<string,string|number|boolean|null>;
}
export interface FlightPage { records:FlightRecord[]; next:number|null; gaps:string[]; costSummary?:{stage:string;currency:string;knownAtomic:string;estimatedAtomic:string;unknown:number;retryAtomic:string}[]; }
export interface FlightFilter {rootTaskId?:string;runId?:string;after?:number;limit?:number;stage?:string;agentId?:string;failed?:boolean;search?:string;minAtomic?:string;sort?:'sequence'|'cost';}
/** Explicitly requested historical mutation proof; never embedded in metadata diagnostics. */
export interface FlightArtifactDiff {toolCallId:string;runId:string;relativePath:string;oldSha256:string|null;newSha256:string;patch:string;truncated:boolean;basis:'recorded_tool_output';}
