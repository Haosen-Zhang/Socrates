/** Read-only view of existing executions; this is not a durable WorkItem. */
export interface WorkActivityRecord {
  id: string;
  source: "command" | "legacy_task";
  roomId: string;
  commandId?: string;
  taskId?: string;
  runId?: string;
  kind: "direct" | "discussion" | "team";
  prompt: string;
  status: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  attemptNo?: number;
}

export interface WorkActivityEvent {
  id: string;
  type: string;
  /** Older discussion events did not persist occurrence times. */
  occurredAt: string | null;
  agentId?: string;
  runId?: string;
}

export interface WorkActivityDetail {
  activity: WorkActivityRecord;
  events: WorkActivityEvent[];
  truncated: boolean;
}

export const WORK_ACTIVITY_LIMIT = 50;
export const WORK_ACTIVITY_EVENT_LIMIT = 500;
