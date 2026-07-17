export interface PlanStep {
  id: string;
  title: string;
  description: string;
  files: string[];
  commands: string[];
  risks: string[];
  verification: string[];
}

export interface StructuredPlan {
  objective: string;
  summary: string;
  steps: PlanStep[];
  evidence: Array<{ refId: string; snapshotHash: string }>;
}

export function validateStructuredPlan(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["plan_object_required"];
  const plan = value as Partial<StructuredPlan>;
  const errors: string[] = [];
  if (typeof plan.objective !== "string" || !plan.objective.trim()) errors.push("plan_objective_required");
  if (typeof plan.summary !== "string" || !plan.summary.trim()) errors.push("plan_summary_required");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > 50) errors.push("plan_steps_invalid");
  else for (const [index, step] of plan.steps.entries()) {
    if (!step || typeof step !== "object" || typeof step.id !== "string" || typeof step.title !== "string" || typeof step.description !== "string") errors.push(`plan_step_invalid:${index}`);
    for (const key of ["files", "commands", "risks", "verification"] as const) if (!Array.isArray(step?.[key]) || !step[key].every((item) => typeof item === "string")) errors.push(`plan_step_${key}_invalid:${index}`);
  }
  if (!Array.isArray(plan.evidence) || !plan.evidence.every((item) => item && typeof item.refId === "string" && typeof item.snapshotHash === "string")) errors.push("plan_evidence_invalid");
  return errors;
}

export function canonicalPlan(value: StructuredPlan): string {
  const canonical = (input: unknown): unknown => Array.isArray(input)
    ? input.map(canonical)
    : input && typeof input === "object"
      ? Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
      : input;
  return JSON.stringify(canonical(value));
}

export async function hashStructuredPlan(value: StructuredPlan): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPlan(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
