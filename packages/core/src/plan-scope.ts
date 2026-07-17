import type { StructuredPlan } from "./plan";

export function toolWithinPlanScope(plan: StructuredPlan, call: { name: string; input: unknown }): boolean {
  const values: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(visit);
  };
  visit(call.input);
  if (call.name === "shell_command") {
    const commands = plan.steps.flatMap((step) => step.commands).map((item) => item.trim()).filter(Boolean);
    return commands.length > 0 && values.some((value) => commands.some((command) => value.trim() === command || value.includes(command)));
  }
  if (call.name === "file_change") {
    const files = new Set(plan.steps.flatMap((step) => step.files).map((item) => item.replace(/^\.\//u, "")));
    return files.size > 0 && values.some((value) => files.has(value.replace(/^\.\//u, "")));
  }
  return false;
}
