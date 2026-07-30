export function agentRunErrorKey(error: string): string {
  return error === "context_current_unit_exceeds_budget"
    ? "agent_error_context_budget"
    : error;
}
