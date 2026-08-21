const ACTIVE_RUN_STATUSES = new Set(["preparing", "running", "awaiting_approval"]);

export interface AgentRunStatusView {
  status: string;
  error: string | null;
}

export function agentRunStateAfterObservation(
  runId: string,
  run: AgentRunStatusView | null,
  transportError: string | null,
): { agentRunning: boolean; activeAgentRunId: string | null; agentError: string | null } {
  if (!run || ACTIVE_RUN_STATUSES.has(run.status)) {
    return {
      agentRunning: true,
      activeAgentRunId: runId,
      agentError: transportError ?? "agent_run_observer_disconnected",
    };
  }
  return {
    agentRunning: false,
    activeAgentRunId: null,
    agentError: run.status === "failed"
      ? run.error
      : run.status === "completed" ? null : transportError,
  };
}

export async function pollAgentRunUntilTerminal(
  load: () => Promise<AgentRunStatusView>,
  continuePolling: () => boolean,
  wait: (milliseconds: number) => Promise<void>,
  intervalMs = 1_000,
): Promise<AgentRunStatusView | null> {
  while (continuePolling()) {
    try {
      const run = await load();
      if (!continuePolling()) return null;
      if (!ACTIVE_RUN_STATUSES.has(run.status)) return run;
    } catch {
      // A transient status transport failure must not discard the only
      // cancellation handle for a Run that is still owned by the sidecar.
    }
    await wait(intervalMs);
  }
  return null;
}
