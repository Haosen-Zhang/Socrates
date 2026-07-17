import { describe, expect, it } from "bun:test";
import { toolWithinPlanScope } from "./plan-scope";

const plan = { objective: "x", summary: "y", steps: [{ id: "1", title: "edit", description: "d", files: ["src/a.ts"], commands: ["bun test"], risks: [], verification: [] }], evidence: [] };

describe("plan scope", () => {
  it("allows declared exact paths and commands", () => {
    expect(toolWithinPlanScope(plan, { name: "file_change", input: { path: "src/a.ts" } })).toBe(true);
    expect(toolWithinPlanScope(plan, { name: "shell_command", input: { command: "bun test" } })).toBe(true);
  });
  it("fails closed for expansion and unknown calls", () => {
    expect(toolWithinPlanScope(plan, { name: "file_change", input: { path: "src/b.ts" } })).toBe(false);
    expect(toolWithinPlanScope(plan, { name: "network", input: {} })).toBe(false);
  });
});
