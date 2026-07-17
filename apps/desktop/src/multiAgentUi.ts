export function moveAgentId(order: string[], id: string, delta: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return order;
  const to = Math.max(0, Math.min(order.length - 1, from + delta));
  if (from === to) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

export function dropAgentBefore(order: string[], source: string, target: string): string[] {
  if (source === target || !order.includes(source) || !order.includes(target)) return order;
  const next = order.filter((item) => item !== source);
  next.splice(next.indexOf(target), 0, source);
  return next;
}

export function canReviewPlan(state: string, planStatus: string): boolean {
  return state === "awaiting_plan_approval" && planStatus === "pending";
}
