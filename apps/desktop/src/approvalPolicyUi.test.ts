import { describe, expect, it } from "bun:test";
import type { ConversationSession } from "@socrates/core";
import { approvalModeOptions, commitApprovalPolicyUpdate } from "./approvalPolicyUi";

describe("approval policy selector", () => {
  it("disables modes the backend capability handshake does not support", () => {
    const options = approvalModeOptions({
      supportedModes: ["ask", "auto_safe"],
      defaultMode: "ask",
      policyVersion: 1,
      hardDenials: ["outside.write", "secret.read"],
      freshHumanRisks: ["destructive"],
    });

    expect(options.map(({ mode, supported }) => [mode, supported])).toEqual([
      ["ask", true],
      ["auto_safe", true],
      ["workspace_full", false],
    ]);
    expect(options[1]).toMatchObject({
      labelKey: "approval_mode_auto_safe",
      descriptionKey: "approval_mode_auto_safe_description",
    });
  });

  it("fails closed before the capability handshake arrives", () => {
    expect(approvalModeOptions(null).every((option) => !option.supported)).toBe(true);
  });

  it("commits the backend-returned room policy/version without changing another room", async () => {
    const room = (id: string, mode: "ask" | "auto_safe", version: number) => ({
      id,
      approvalPolicy: { mode, version },
    }) as ConversationSession;
    const before = [room("selected", "ask", 1), room("other", "ask", 1)];
    const after = await commitApprovalPolicyUpdate(
      () => before,
      async () => room("selected", "auto_safe", 2),
    );
    expect(after.map((session) => [session.id, session.approvalPolicy])).toEqual([
      ["selected", { mode: "auto_safe", version: 2 }],
      ["other", { mode: "ask", version: 1 }],
    ]);
    expect(before[0]?.approvalPolicy).toEqual({ mode: "ask", version: 1 });
  });

  it("keeps current UI state untouched when the backend rejects an update", async () => {
    const before = [{ id: "selected", approvalPolicy: { mode: "ask", version: 1 } }] as ConversationSession[];
    await expect(commitApprovalPolicyUpdate(() => before, async () => {
      throw new Error("invalid_approval_policy");
    })).rejects.toThrow("invalid_approval_policy");
    expect(before[0]?.approvalPolicy).toEqual({ mode: "ask", version: 1 });
  });
});
