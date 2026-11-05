import { describe, expect, it } from "bun:test";
import { validateWorkPackages } from "./work-package";

const one = { id: "a", title: "A", objective: "Change A", input: "task", dependencies: [], executorAgentId: "alice", reviewerAgentId: "bob", expectedFiles: ["a.ts"], acceptanceCriteria: ["tests pass"] };
describe("work package plan", () => {
  it("rejects cycles, unknown owners and self review", () => {
    expect(validateWorkPackages([one, { ...one, id: "b", dependencies: ["a"], executorAgentId: "bob", reviewerAgentId: null }], ["alice", "bob"])).toEqual([]);
    expect(validateWorkPackages([{ ...one, dependencies: ["b"] }, { ...one, id: "b", dependencies: ["a"] }], ["alice", "bob"])).toContain("work_package_dependency_cycle");
    expect(validateWorkPackages([{ ...one, executorAgentId: "outsider" }], ["alice", "bob"])).toContain("work_package_executor_not_member:a");
    expect(validateWorkPackages([{ ...one, reviewerAgentId: "alice" }], ["alice", "bob"])).toContain("work_package_self_review:a");
  });
  it("requires acceptance criteria and unambiguous stable package ids", () => {
    expect(validateWorkPackages([{ ...one, acceptanceCriteria: [] }])).toContain("work_package_acceptance_required:a");
    expect(validateWorkPackages([one, one])).toContain("work_package_duplicate_id:a");
    expect(validateWorkPackages([{ ...one, dependencies: ["absent"] }])).toContain("work_package_dependency_missing:a");
  });
});
