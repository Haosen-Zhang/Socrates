import { isReusableProjectWorkspace, type WorkspaceRecord } from "@socrates/core";
import type { WorkspaceSelection } from "../roomSelection";

export function selectableProjectWorkspaces(workspaces: WorkspaceRecord[]): WorkspaceRecord[] {
  return workspaces.filter(isReusableProjectWorkspace);
}

export async function prepareNewRoomWorkspace(input: {
  mode: "temporary" | "project";
  workspaceId: string | null;
  pickAndRegisterWorkspace?: () => Promise<{ id: string } | null>;
}): Promise<WorkspaceSelection | null> {
  if (input.mode === "temporary") return { kind: "managed" };
  if (input.workspaceId) return { kind: "existing", workspaceId: input.workspaceId };
  if (!input.pickAndRegisterWorkspace) throw new Error("room_workspace_required");
  const workspace = await input.pickAndRegisterWorkspace();
  if (!workspace) return null;
  return { kind: "existing", workspaceId: workspace.id };
}
