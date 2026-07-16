import { modeToolCeiling, type AgentRunPhase, type ConversationMode, type ToolCapability } from "./conversation";
import type { ToolRisk } from "./tools";

export type PermissionEffect = "allow" | "ask" | "deny";
export type PermissionAction =
  | "workspace.read"
  | "workspace.write"
  | "outside.read"
  | "outside.write"
  | "shell.execute"
  | "network.request"
  | "mcp.invoke"
  | "secret.read";

export interface PermissionRule {
  id: string;
  action: PermissionAction | "*";
  resourcePattern: string;
  effect: PermissionEffect;
  hardDeny?: boolean;
}

export interface PermissionInput {
  action: PermissionAction;
  resource: string;
  risk: ToolRisk;
  mode: ConversationMode;
  phase: AgentRunPhase;
  capabilityAllowed: boolean;
  policyVersion: number;
  rules: PermissionRule[];
  hardDenyReason?: string;
  exactGrant?: boolean;
}

export interface PermissionEvaluation {
  effect: PermissionEffect;
  risk: ToolRisk;
  matchedRuleIds: string[];
  reasonCode: string;
  freshHumanRequired: boolean;
  policyVersion: number;
}

const severity: Record<PermissionEffect, number> = { allow: 0, ask: 1, deny: 2 };

function capabilityForAction(action: PermissionAction): ToolCapability | undefined {
  if (action === "workspace.read") return "workspace_read";
  if (action === "workspace.write" || action === "outside.write") return "workspace_write";
  if (action === "shell.execute") return "shell";
  if (action === "network.request") return "network";
  if (action === "mcp.invoke") return "mcp";
  return undefined;
}

function matches(pattern: string, resource: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === resource;
  const parts = pattern.split("*");
  return resource.startsWith(parts[0]) && resource.endsWith(parts[parts.length - 1] ?? "");
}

export function evaluatePermission(input: PermissionInput): PermissionEvaluation {
  const freshHumanRequired = input.risk === "destructive" || input.action === "outside.write" || input.action === "secret.read";
  const result = (effect: PermissionEffect, reasonCode: string, matchedRuleIds: string[] = []): PermissionEvaluation => ({
    effect,
    risk: input.risk,
    matchedRuleIds,
    reasonCode,
    freshHumanRequired,
    policyVersion: input.policyVersion,
  });
  if (input.hardDenyReason) return result("deny", input.hardDenyReason);
  if (!input.capabilityAllowed) return result("deny", "capability_ceiling");
  const capability = capabilityForAction(input.action);
  if (!capability || !modeToolCeiling(input.mode, input.phase).includes(capability)) return result("deny", "mode_ceiling");
  if (input.action === "outside.write" || input.action === "secret.read") return result("deny", "global_hard_deny");

  const matched = input.rules.filter((rule) => (rule.action === "*" || rule.action === input.action) && matches(rule.resourcePattern, input.resource));
  if (matched.some((rule) => rule.hardDeny)) return result("deny", "scoped_hard_deny", matched.map((rule) => rule.id));
  if (matched.length) {
    const strictest = matched.reduce((effect, rule) => severity[rule.effect] > severity[effect] ? rule.effect : effect, "allow" as PermissionEffect);
    if (strictest !== "allow") return result(strictest, "scoped_rule", matched.map((rule) => rule.id));
  }
  if (input.exactGrant && !freshHumanRequired) return result("allow", "exact_grant", matched.map((rule) => rule.id));
  if (matched.some((rule) => rule.effect === "allow")) return result("allow", "scoped_rule", matched.map((rule) => rule.id));
  return result("ask", "safe_default");
}
