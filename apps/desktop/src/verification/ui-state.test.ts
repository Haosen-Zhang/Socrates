import { expect, it } from "bun:test";
import { buildCheck, emptyCheckDraft, parsePaths, VerificationMutationGate, VerificationReadGuard } from "./ui-state";

it("preserves exact argv instead of splitting shell text", () => {
  const check = buildCheck({ ...emptyCheckDraft(), kind: "command", label: "Tests", executable: "bun", argv: '["test", "folder with spaces/example.test.ts"]', category: "test", parser: "bun_test" }, "test-1");
  expect(check.kind).toBe("command");
  if (check.kind !== "command") throw Error("command expected");
  expect(check.command.argv).toEqual(["test", "folder with spaces/example.test.ts"]);
  expect(check.minTests).toBe(1);
  expect(() => buildCheck({ ...emptyCheckDraft(), kind: "command", label: "Bad", executable: "bun", argv: 'test && echo passed' }, "bad")).toThrow("verification_invalid_argv");
});

it("requires meaningful file assertions and a real schema object", () => {
  const file = buildCheck({ ...emptyCheckDraft(), label: "Report", path: "result.md" }, "file-1");
  expect(file).toMatchObject({ kind: "file", path: "result.md", minBytes: 1, required: true, origin: "user" });
  expect(() => buildCheck({ ...emptyCheckDraft(), kind: "json_schema", label: "Data", path: "data.json", schema: '"not a schema"' }, "bad")).toThrow("verification_invalid_schema");
  expect(parsePaths("src\n src \nresult.json\n")).toEqual(["src", "result.json"]);
});

it("does not let a stale read replace a newer verification or a different target", () => {
  const guard = new VerificationReadGuard();
  const old = guard.begin();
  const current = guard.begin();
  expect(guard.accepts(old)).toBe(false);
  expect(guard.accepts(current)).toBe(true);
  guard.invalidate();
  expect(guard.accepts(current)).toBe(false);
});

it("allows a single cancellation while an approved process is pending without admitting duplicate commands", () => {
  const gate = new VerificationMutationGate();
  expect(gate.begin("/approvals/command/decision")).toBe(true);
  expect(gate.begin("/approvals/command/decision")).toBe(false);
  expect(gate.begin("/cancel")).toBe(true);
  expect(gate.begin("/cancel")).toBe(false);
  gate.finish("/approvals/command/decision");
  expect(gate.begin("/run")).toBe(false);
  gate.finish("/cancel");
  expect(gate.begin("/run")).toBe(true);
});
