import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { VerificationView } from "@socrates/core";
import VerificationResultView from "./VerificationResultView";
import VerificationActions from "./VerificationActions";
import { verificationSummary } from "./ui-state";

function fixture(): VerificationView {
  const target = { roomId: "room", rootTaskId: "task" };
  const snapshot = { hash: "artifact-v1", paths: ["result.ts"], files: [{ path: "result.ts", sha256: "file-v1", byteSize: 42, kind: "file" as const }], createdAt: "2026-11-07T00:00:00Z" };
  return {
    target, verificationStatus: "passed", outcome: "verified_success", acceptedUnverified: false, gatePassed: true,
    plan: { id: "plan", target, workspaceIdentity: "workspace-hash", version: 1, hash: "plan-hash", source: "user", risk: "local_checks", approvalStatus: "approved", approvedAt: "2026-11-07T00:00:00Z", createdAt: "2026-11-07T00:00:00Z", artifactPaths: ["result.ts"], protectedPaths: ["result.test.ts"], baselineSnapshot: snapshot, protectedSnapshot: snapshot, manualJudgment: [], checks: [{ id: "tests", label: "Independent tests", required: true, origin: "repository", kind: "command", category: "test", command: { executable: "bun", argv: ["test", "result.test.ts"], cwd: "." }, parser: "bun_test", minTests: 1 }] },
    run: { id: "verification-run", target, planId: "plan", planVersion: 1, planHash: "plan-hash", requestId: "request", agentId: "worker", mode: "final", status: "passed", outcome: "verified_success", snapshot, pendingApprovals: [], startedAt: "2026-11-07T00:00:01Z", finishedAt: "2026-11-07T00:00:02Z", evidence: [{ id: "evidence", checkId: "tests", planVersion: 1, planHash: "plan-hash", runId: "verification-run", artifactSnapshotHash: "artifact-v1", implementationHash: "frozen-test", status: "passed", reason: "required_checks_passed", startedAt: "2026-11-07T00:00:01Z", finishedAt: "2026-11-07T00:00:02Z", durationMs: 1000, runnerVersion: "supervised-command/1", environment: {}, command: { executable: "bun", argv: ["test", "result.test.ts"], cwd: "." }, exitCode: 0, timedOut: false, operationId: "actual-tool-operation", counts: { tests: 2, passed: 2, failed: 0, skipped: 0 }, changedPaths: [] }] },
  };
}

it("marks only current final evidence as verified and shows its real process and artifact identities", () => {
  const view = fixture();
  expect(verificationSummary(view)).toEqual({ passed: 1, total: 1, verified: true });
  const html = renderToStaticMarkup(<VerificationResultView view={view} />);
  expect(html).toContain('data-tone="success"');
  expect(html).toContain("actual-tool-operation");
  expect(html).toContain("artifact-v1");
  expect(html).toContain("supervised-command/1");
  expect(html).toContain("result.test.ts");
});

it("does not show a current green result for stale artifacts, changed plans, baseline-only or zero-test evidence", () => {
  const variants: VerificationView[] = [];
  const invalidated = fixture(); invalidated.verificationStatus = "invalidated"; variants.push(invalidated);
  const changedPlan = fixture(); changedPlan.plan!.hash = "new-plan"; variants.push(changedPlan);
  const baseline = fixture(); baseline.run!.mode = "baseline"; variants.push(baseline);
  const noTests = fixture(); noTests.run!.evidence[0]!.counts = { tests: 0, passed: 0, failed: 0, skipped: 0 }; variants.push(noTests);
  const skipped = fixture(); skipped.run!.evidence[0]!.counts = { tests: 2, passed: 0, failed: 0, skipped: 2 }; variants.push(skipped);
  const changedArtifact = fixture(); changedArtifact.run!.snapshot.hash = "artifact-v2"; variants.push(changedArtifact);
  for (const view of variants) {
    expect(verificationSummary(view).verified).toBe(false);
    expect(renderToStaticMarkup(<VerificationResultView view={view} />)).not.toContain('data-tone="success"');
  }
});

it("keeps acceptance of unverified work separate from failed checks and green completion", () => {
  const view = fixture(); view.acceptedUnverified = true; view.verificationStatus = "failed"; view.outcome = "completed_unverified"; view.run!.evidence[0]!.status = "failed"; view.run!.evidence[0]!.exitCode = 1; view.run!.evidence[0]!.diagnostics = "Worker claimed all tests passed; actual runner returned exit 1";
  const html = renderToStaticMarkup(<VerificationResultView view={view} />);
  expect(html).toContain('data-verification-status="failed"');
  expect(html).toContain('data-tone="warning"');
  expect(html).not.toContain('data-tone="success"');
  expect(html).toContain("actual runner returned exit 1");
});

it("requires an explicit exact-command decision and does not offer rerunning a pending check", () => {
  const view = fixture(); view.verificationStatus = "pending"; view.run!.status = "pending"; view.run!.finishedAt = null;
  view.run!.pendingApprovals = [{ id: "approval", checkId: "tests", operationId: "operation", command: { executable: "bun", argv: ["test", "a b.test.ts"], cwd: "tests", timeoutMs: 2000 } }];
  const html = renderToStaticMarkup(<VerificationActions view={view} busy={false} onAction={() => {}} />);
  expect(html).toContain("a b.test.ts");
  expect(html).toContain("<code>tests</code>");
  expect(html.match(/<button/g)).toHaveLength(3); // allow once, deny, stop; no duplicate run or session-wide allow.
});

it("keeps cancellation available while command approval waits for the process", () => {
  const view = fixture(); view.verificationStatus = "running"; view.run!.status = "running"; view.run!.finishedAt = null;
  const html = renderToStaticMarkup(<VerificationActions view={view} busy onAction={() => {}} />);
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).not.toContain('disabled=""');
  expect(renderToStaticMarkup(<VerificationActions view={view} busy cancelling onAction={() => {}} />)).toContain('disabled=""');
  view.run!.mode = "baseline"; view.verificationStatus = "pending";
  expect(renderToStaticMarkup(<VerificationResultView view={view} />)).toContain('data-verification-status="running"');
});

it("does not turn passing integration checks or stale reads into verified completion", () => {
  const view = fixture(); view.outcome = "completed_unverified"; view.unverifiedPackageIds = ["locally-accepted-package"];
  expect(verificationSummary(view).verified).toBe(false);
  expect(renderToStaticMarkup(<VerificationResultView view={view} />)).not.toContain('data-tone="success"');
  expect(renderToStaticMarkup(<VerificationResultView view={fixture()} stale />)).not.toContain('data-tone="success"');
});
