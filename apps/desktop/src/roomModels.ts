import type { WorkPackageDefinition, WorkPackageState } from "@socrates/core";

export interface WorkPackageView extends WorkPackageDefinition {
  taskId: string;
  state: WorkPackageState;
  attemptNo: number;
  runId: string | null;
  result: string | null;
  failureReason: string | null;
  queueReason?: string | null;
}
export type TeamSummaryView = {
  completed: Array<{
    id: string;
    title: string;
    agentId: string;
    result: string | null;
  }>;
  unfinished: Array<{
    id: string;
    title: string;
    state: string;
    reason: string | null;
  }>;
  verification: Array<{
    packageId: string;
    acceptanceCriteria: string[];
    reviewerAgentId: string | null;
    reviewNotes: string | null;
    result: string | null;
  }>;
  artifacts: Array<{
    packageId: string;
    path: string;
    toolOperationId?: string;
    runId?: string;
    source?: "persisted_tool_result";
    reported?: boolean;
  }>;
};
