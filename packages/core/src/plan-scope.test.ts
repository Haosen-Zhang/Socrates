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
  it("matches native structured commands with exact argv and cwd", () => {
    expect(toolWithinPlanScope(plan, { name: "run_shell", input: { executable: "bun", argv: ["test"] } })).toBe(true);
    expect(toolWithinPlanScope(plan, { name: "run_command", input: { executable: "bun", argv: ["test"], cwd: "./" } })).toBe(true);
    expect(toolWithinPlanScope(plan, { name: "run_shell", input: { executable: "bun", argv: ["test", "--update-snapshots"] } })).toBe(false);
    expect(toolWithinPlanScope(plan, { name: "run_shell", input: { executable: "bun", argv: ["test"], cwd: "other-project" } })).toBe(false);
    const quoted = { ...plan, steps: [{ ...plan.steps[0]!, commands: ['cd "apps/desktop" && bun test "two words.test.ts"'] }] };
    expect(toolWithinPlanScope(quoted, { name: "run_command", input: { executable: "bun", argv: ["test", "two words.test.ts"], cwd: "./apps//desktop" } })).toBe(true);
    expect(toolWithinPlanScope(quoted, { name: "run_command", input: { executable: "bun", argv: ["test", "two", "words.test.ts"], cwd: "apps/desktop" } })).toBe(false);
  });
  it("matches actual file fields without accepting content or traversal as a path", () => {
    expect(toolWithinPlanScope(plan, { name: "write_file", input: { path: "./src//a.ts", content: "new" } })).toBe(true);
    expect(toolWithinPlanScope(plan, { name: "edit_file", input: { path: "src/a.ts", oldText: "old", newText: "new" } })).toBe(true);
    expect(toolWithinPlanScope(plan, { name: "write_file", input: { path: "src/b.ts", content: "src/a.ts" } })).toBe(false);
    expect(toolWithinPlanScope(plan, { name: "write_file", input: { path: "../src/a.ts" } })).toBe(false);
    expect(toolWithinPlanScope(plan, { name: "move_path", input: { source: "src/a.ts", destination: "outside.ts" } })).toBe(false);
  });
  it("does not approve a larger legacy command containing an approved command as a substring", () => {
    expect(toolWithinPlanScope(plan, { name: "shell_command", input: { command: "bun test && rm -rf src" } })).toBe(false);
    expect(toolWithinPlanScope(plan, { name: "shell_command", input: { command: "echo bun test" } })).toBe(false);
    expect(toolWithinPlanScope(plan, { name: "shell_command", input: { command: "rm -rf src", note: "bun test" } })).toBe(false);
  });

});
