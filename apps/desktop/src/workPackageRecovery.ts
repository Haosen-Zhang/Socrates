type RecoveryPackage = {
  id: string;
  runId: string | null;
  attemptNo: number;
  failureReason: string | null;
};

export function packageRecoveryKey(item: RecoveryPackage): string {
  return JSON.stringify([
    item.id,
    item.runId,
    item.attemptNo,
    item.failureReason,
  ]);
}

/** A confirmation applies only to the package attempt the user actually reviewed. */
export function workPackageRetryInput(
  item: Pick<RecoveryPackage, "failureReason">,
  reviewed: boolean,
): { confirmOutcomeUnknown?: true } | null {
  if (item.failureReason !== "execution_outcome_unknown") return {};
  return reviewed ? { confirmOutcomeUnknown: true } : null;
}

export function taskResumeAction(task: {
  workPackages?: readonly unknown[];
  outcomeUnknown: boolean;
  requiresExecutionReview: boolean;
}): "packages" | "retry" | "resume" {
  if (task.workPackages?.length) return "packages";
  return task.outcomeUnknown || task.requiresExecutionReview
    ? "retry"
    : "resume";
}
