export function canCommitMultiTaskLoad(
  selectedSessionId: string | null,
  loadedSessionId: string,
): boolean {
  return selectedSessionId === loadedSessionId;
}
