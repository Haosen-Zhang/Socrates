import { expect, it } from "bun:test";
import { verificationConclusion, type CheckEvidence, type VerificationCheck } from "./verification";

const required: VerificationCheck = { id: "independent", label: "Independent acceptance", required: true, origin: "user", kind: "file", path: "answer.json" };
const evidence = (checkId: string, status: CheckEvidence["status"]): CheckEvidence => ({ checkId, status, id: checkId, planVersion: 1, planHash: "plan", runId: "run", artifactSnapshotHash: "artifact", implementationHash: "check",
  reason: "fixture", startedAt: "now", finishedAt: "later", durationMs: 1, runnerVersion: "test", environment: {}, changedPaths: [] });

it("requires every required objective check and does not turn optional success into acceptance", () => {
  expect(verificationConclusion([required], [], []).status).toBe("inconclusive");
  expect(verificationConclusion([{ ...required, required: false }], [evidence(required.id, "passed")], []).status).toBe("inconclusive");
  expect(verificationConclusion([required], [evidence(required.id, "failed")], [])).toMatchObject({ status: "failed", outcome: "verification_failed" });
  expect(verificationConclusion([required], [evidence(required.id, "invalidated")], []).status).toBe("inconclusive");
});
it("worker authored checks alone cannot certify themselves and human conditions remain explicit", () => {
  expect(verificationConclusion([{ ...required, origin: "worker" }], [evidence(required.id, "passed")], []).reason).toBe("independent_acceptance_required");
  expect(verificationConclusion([required], [evidence(required.id, "passed")], ["Evaluate factual correctness"]).reason).toBe("manual_judgment_required");
  expect(verificationConclusion([required], [evidence(required.id, "passed")], [])).toMatchObject({ status: "passed", outcome: "verified_success" });
});
