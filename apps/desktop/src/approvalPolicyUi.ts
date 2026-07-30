import {
  TOOL_APPROVAL_CAPABILITIES,
  type ToolApprovalCapabilities,
  type ToolApprovalMode,
  type ConversationSession,
} from "@socrates/core";

export type ApprovalModeOption = {
  mode: ToolApprovalMode;
  supported: boolean;
  labelKey: `approval_mode_${ToolApprovalMode}`;
  descriptionKey: `approval_mode_${ToolApprovalMode}_description`;
};

export function approvalModeOptions(
  capabilities: ToolApprovalCapabilities | null | undefined,
): ApprovalModeOption[] {
  return TOOL_APPROVAL_CAPABILITIES.supportedModes.map((mode) => ({
    mode,
    supported: capabilities?.supportedModes.includes(mode) === true,
    labelKey: `approval_mode_${mode}`,
    descriptionKey: `approval_mode_${mode}_description`,
  }));
}

export async function commitApprovalPolicyUpdate(
  getSessions: () => ConversationSession[],
  request: () => Promise<ConversationSession>,
): Promise<ConversationSession[]> {
  const updated = await request();
  return getSessions().map((session) => session.id === updated.id ? updated : session);
}
