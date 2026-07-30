import { describe, expect, it } from "bun:test";
import { evaluatePermission, type PermissionInput } from "./permissions";

const base: PermissionInput = {
  action: "workspace.read",
  resource: "src/index.ts",
  risk: "low",
  mode: "single_agent",
  phase: "executing",
  capabilityAllowed: true,
  policyVersion: 1,
  rules: [],
};

describe("permission precedence", () => {
  it("hard deny wins over scoped allow and grant", () => {
    const result = evaluatePermission({
      ...base,
      hardDenyReason: "secret_path",
      exactGrant: true,
      rules: [{ id: "allow", action: "workspace.read", resourcePattern: "*", effect: "allow" }],
    });
    expect(result.effect).toBe("deny");
    expect(result.reasonCode).toBe("secret_path");
  });

  it("chat mode denies tools and multi discussion denies writes", () => {
    expect(evaluatePermission({ ...base, mode: "chat" }).effect).toBe("deny");
    expect(evaluatePermission({ ...base, action: "workspace.write", mode: "multi_agent", phase: "discussing" }).effect).toBe("deny");
  });

  it("uses exact grant only after ceilings and rules", () => {
    expect(evaluatePermission({ ...base, exactGrant: true }).effect).toBe("allow");
    expect(evaluatePermission({ ...base, capabilityAllowed: false, exactGrant: true }).effect).toBe("deny");
  });

  it("applies the room approval-mode matrix without weakening hard boundaries", () => {
    expect(evaluatePermission({ ...base, approvalMode: "ask" })).toMatchObject({
      effect: "allow",
      reasonCode: "safe_read",
    });
    expect(evaluatePermission({
      ...base,
      action: "workspace.write",
      approvalMode: "ask",
    }).effect).toBe("ask");
    expect(evaluatePermission({
      ...base,
      action: "workspace.write",
      approvalMode: "auto_safe",
    }).effect).toBe("allow");
    expect(evaluatePermission({
      ...base,
      action: "workspace.write",
      risk: "high",
      approvalMode: "auto_safe",
    }).effect).toBe("ask");
    expect(evaluatePermission({
      ...base,
      action: "workspace.write",
      risk: "high",
      approvalMode: "workspace_full",
    }).effect).toBe("allow");
    expect(evaluatePermission({
      ...base,
      action: "shell.execute",
      risk: "medium",
      approvalMode: "workspace_full",
    }).effect).toBe("ask");
    expect(evaluatePermission({
      ...base,
      action: "outside.write",
      approvalMode: "workspace_full",
    }).effect).toBe("deny");
  });

  it("always asks for a fresh human on destructive operations", () => {
    const result = evaluatePermission({
      ...base,
      action: "workspace.write",
      risk: "destructive",
      approvalMode: "workspace_full",
      rules: [{ id: "broad-allow", action: "*", resourcePattern: "*", effect: "allow" }],
    });
    expect(result).toMatchObject({
      effect: "ask",
      freshHumanRequired: true,
      reasonCode: "fresh_human_required",
    });
  });

  it("fails closed when persisted policy data is unknown", () => {
    expect(evaluatePermission({
      ...base,
      action: "workspace.write",
      approvalMode: "corrupt" as "ask",
    })).toMatchObject({
      effect: "ask",
      reasonCode: "approval_mode_unknown",
    });
  });
});
