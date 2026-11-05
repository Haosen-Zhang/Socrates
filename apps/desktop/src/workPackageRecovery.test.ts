import { describe, expect, it } from "bun:test";
import {
  packageRecoveryKey,
  workPackageRetryInput,
  taskResumeAction,
} from "./workPackageRecovery";

describe("work package recovery", () => {
  const item = {
    id: "task/package",
    runId: "run-one",
    attemptNo: 1,
    failureReason: "execution_outcome_unknown",
  };
  it("requires explicit review before confirming an unknown execution outcome", () => {
    expect(workPackageRetryInput(item, false)).toBeNull();
    expect(workPackageRetryInput(item, true)).toEqual({
      confirmOutcomeUnknown: true,
    });
    expect(
      workPackageRetryInput({ ...item, failureReason: null }, false),
    ).toEqual({});
  });
  it("does not carry confirmation into another execution attempt", () => {
    expect(packageRecoveryKey(item)).not.toBe(
      packageRecoveryKey({ ...item, attemptNo: 2, runId: "run-two" }),
    );
  });
  it("routes paused package teams to their individual recovery controls", () => {
    expect(
      taskResumeAction({
        workPackages: [item],
        outcomeUnknown: true,
        requiresExecutionReview: true,
      }),
    ).toBe("packages");
    expect(
      taskResumeAction({
        workPackages: [],
        outcomeUnknown: true,
        requiresExecutionReview: false,
      }),
    ).toBe("retry");
    expect(
      taskResumeAction({
        workPackages: [],
        outcomeUnknown: false,
        requiresExecutionReview: false,
      }),
    ).toBe("resume");
  });
});
