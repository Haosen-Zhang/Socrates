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
});
