import { describe, expect, it } from "bun:test";
import { canonicalPlan, hashStructuredPlan, validateStructuredPlan, type StructuredPlan } from "./plan";

const plan: StructuredPlan = { objective: "Ship", summary: "Implement safely", steps: [{ id: "1", title: "Edit", description: "change", files: ["src/a.ts"], commands: [], risks: ["regression"], verification: ["bun test"] }], evidence: [] };

describe("structured plan", () => {
  it("validates and hashes canonical content stably", async () => {
    expect(validateStructuredPlan(plan)).toEqual([]);
    expect(canonicalPlan(plan)).toContain('"objective":"Ship"');
    expect(await hashStructuredPlan(plan)).toBe(await hashStructuredPlan(JSON.parse(JSON.stringify(plan))));
  });
  it("rejects prose and incomplete steps", () => {
    expect(validateStructuredPlan("markdown")).toEqual(["plan_object_required"]);
    expect(validateStructuredPlan({ objective: "x", summary: "y", steps: [], evidence: [] })).toContain("plan_steps_invalid");
  });
});
