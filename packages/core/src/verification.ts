export type VerificationStatus = "not_requested" | "pending" | "running" | "passed" | "failed" | "inconclusive" | "invalidated";
export type TaskOutcome = "verified_success" | "completed_unverified" | "verification_failed" | "blocked" | "cancelled" | "failed";
export interface VerificationTarget { roomId: string; rootTaskId: string; workPackageId?: string }
export interface VerificationCheckBase {
  id: string;
  label: string;
  required: boolean;
  /** Worker-authored checks are useful diagnostics, not independent acceptance. */
  origin?: "user" | "repository" | "worker";
  definitionPaths?: string[];
}
export type VerificationCheck = VerificationCheckBase & (
  | { kind: "command"; category: "test" | "typecheck" | "build" | "lint"; command: { executable: string; argv: string[]; cwd?: string; timeoutMs?: number };
      parser: "exit_code" | "bun_test" | "tap" | "junit" | "unsupported"; reportPath?: string; minTests?: number }
  | { kind: "file"; path: string; minBytes?: number; contains?: string; expectedSha256?: string }
  /** Full JSON Schema is interpreted strictly by the sidecar's Ajv adapter. */
  | { kind: "json_schema"; path: string; schema: object }
);
export interface ArtifactSnapshot {
  hash: string;
  paths: string[];
  files: Array<{ path: string; sha256: string | null; byteSize: number; kind: "file" | "directory" | "missing" }>;
  excludedPaths?: string[];
  createdAt: string;
}
export interface VerificationPlan {
  id: string;
  target: VerificationTarget;
  workspaceIdentity: string;
  version: number;
  hash: string;
  sourcePlanId?: string;
  source: "user" | "repository" | "worker";
  risk: "local_checks";
  approvalStatus: "proposed" | "approved";
  approvedAt: string | null;
  createdAt: string;
  checks: VerificationCheck[];
  artifactPaths: string[];
  protectedPaths: string[];
  baselineSnapshot: ArtifactSnapshot;
  protectedSnapshot: ArtifactSnapshot;
  manualJudgment: string[];
  baselineRunId?: string;
}
export interface PrepareVerificationInput {
  roomId: string;
  rootTaskId?: string;
  workPackageId?: string;
  requestId: string;
  checks: VerificationCheck[];
  artifactPaths: string[];
  protectedPaths: string[];
  manualJudgment?: string[];
  source?: VerificationPlan["source"];
}
export interface VerificationPendingApproval {
  id: string;
  checkId: string;
  operationId: string;
  command: { executable: string; argv: string[]; cwd?: string; timeoutMs?: number };
}
export interface CheckEvidence {
  id: string;
  checkId: string;
  planVersion: number;
  planHash: string;
  runId: string;
  executionRunId?: string;
  artifactSnapshotHash: string;
  implementationHash: string;
  status: "passed" | "failed" | "inconclusive" | "invalidated";
  reason: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  runnerVersion: string;
  environment: Record<string, string>;
  command?: { executable: string; argv: string[]; cwd: string };
  exitCode?: number;
  signal?: string | null;
  timedOut?: boolean;
  operationId?: string;
  approvalId?: string;
  stdoutRef?: string;
  stderrRef?: string;
  diagnostics?: string;
  counts?: { tests: number; passed: number; failed: number; skipped: number };
  assertions?: Array<{ name: string; passed: boolean }>;
  baselineStatus?: CheckEvidence["status"];
  changedPaths: string[];
  failureSignature?: string;
}
export interface VerificationRun {
  id: string;
  target: VerificationTarget;
  planId: string;
  planVersion: number;
  planHash: string;
  requestId: string;
  executionRunId?: string;
  agentId: string;
  mode: "baseline" | "final";
  status: Exclude<VerificationStatus, "not_requested">;
  outcome: TaskOutcome;
  reason?: string;
  snapshot: ArtifactSnapshot;
  evidence: CheckEvidence[];
  pendingApprovals: VerificationPendingApproval[];
  startedAt: string;
  finishedAt: string | null;
  failureSignature?: string;
}
export interface VerificationView {
  /** Effective root and current package evidence acknowledged by a human review. */
  evidenceRevision?: string;
  target: VerificationTarget;
  plan: VerificationPlan | null;
  run: VerificationRun | null;
  verificationStatus: VerificationStatus;
  outcome: TaskOutcome;
  acceptedUnverified: boolean;
  gatePassed: boolean;
  /** A passing integration check does not hide accepted or stale local checks. */
  unverifiedPackageIds?: string[];
}
export interface VerifyOptions {
  runId?: string;
  agentId?: string;
  signal?: AbortSignal;
  leaseId?: string;
  requestId?: string;
  baseline?: boolean;
}
export interface VerificationSuggestions {
  checks: VerificationCheck[];
  artifactPaths: string[];
  protectedPaths: string[];
  manualJudgment: string[];
  unsupported: string[];
}

/** An execution report or reviewer prose cannot satisfy a machine check. */
export function verificationConclusion(checks: VerificationCheck[], evidence: CheckEvidence[], manualJudgment: string[]): {
  status: "passed" | "failed" | "inconclusive"; outcome: TaskOutcome; reason: string;
} {
  const required = checks.filter(check => check.required);
  const results = required.map(check => evidence.find(item => item.checkId === check.id));
  if (results.some(item => item?.status === "failed")) return { status: "failed", outcome: "verification_failed", reason: "required_check_failed" };
  if (!required.length || results.some(item => !item || item.status !== "passed")) return { status: "inconclusive", outcome: "completed_unverified", reason: "verification_evidence_insufficient" };
  if (required.every(check => check.origin === "worker")) return { status: "inconclusive", outcome: "completed_unverified", reason: "independent_acceptance_required" };
  if (manualJudgment.length) return { status: "inconclusive", outcome: "completed_unverified", reason: "manual_judgment_required" };
  return { status: "passed", outcome: "verified_success", reason: "required_checks_passed" };
}
