export function toggleRoomAgentSelection(selected: string[], agentId: string): string[] {
  return selected.includes(agentId)
    ? selected.filter((id) => id !== agentId)
    : [...selected, agentId];
}
