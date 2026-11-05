/** A Manager's reviewable assignment. Runtime facts live in the package store. */
export interface WorkPackageDefinition {
  id: string;
  title: string;
  objective: string;
  input: string;
  dependencies: string[];
  executorAgentId: string;
  reviewerAgentId: string | null;
  expectedFiles: string[];
  acceptanceCriteria: string[];
}

export type WorkPackageState = "waiting" | "ready" | "running" | "awaiting_approval" | "awaiting_review" | "completed" | "failed" | "cancelled" | "budget_stopped";

export function validateWorkPackages(raw: unknown, memberIds?: readonly string[]): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) return ["work_packages_invalid"];
  const errors: string[] = [];
  const ids = new Set<string>();
  const packages: WorkPackageDefinition[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) { errors.push("work_package_invalid"); continue; }
    const item = value as WorkPackageDefinition;
    if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 200) { errors.push("work_package_id_invalid"); continue; }
    if (ids.has(item.id)) errors.push(`work_package_duplicate_id:${item.id}`);
    ids.add(item.id);
    for (const field of ["title", "objective", "input", "executorAgentId"] as const) {
      if (typeof item[field] !== "string" || !item[field].trim()) errors.push(`work_package_${field}_invalid:${item.id}`);
    }
    for (const field of ["dependencies", "expectedFiles", "acceptanceCriteria"] as const) {
      if (!Array.isArray(item[field]) || item[field].some((v) => typeof v !== "string" || !v.trim()) || new Set(item[field]).size !== item[field].length) errors.push(`work_package_${field}_invalid:${item.id}`);
    }
    if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length === 0) errors.push(`work_package_acceptance_required:${item.id}`);
    if (item.reviewerAgentId !== null && typeof item.reviewerAgentId !== "string") errors.push(`work_package_reviewer_invalid:${item.id}`);
    if (item.executorAgentId === item.reviewerAgentId) errors.push(`work_package_self_review:${item.id}`);
    if (memberIds && !memberIds.includes(item.executorAgentId)) errors.push(`work_package_executor_not_member:${item.id}`);
    if (memberIds && item.reviewerAgentId !== null && !memberIds.includes(item.reviewerAgentId)) errors.push(`work_package_reviewer_not_member:${item.id}`);
    packages.push(item);
  }
  for (const item of packages) {
    if (Array.isArray(item.dependencies) && item.dependencies.some((id) => !ids.has(id))) errors.push(`work_package_dependency_missing:${item.id}`);
  }
  const byId = new Map(packages.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (seen.has(id)) return false;
    visiting.add(id);
    if ((byId.get(id)?.dependencies ?? []).some((dependency) => visit(dependency))) return true;
    visiting.delete(id);
    seen.add(id);
    return false;
  };
  if (!errors.some((e) => e.includes("dependencies_invalid")) && packages.some((item) => visit(item.id))) errors.push("work_package_dependency_cycle");
  return [...new Set(errors)];
}
