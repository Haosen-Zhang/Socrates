import { expect, test } from "bun:test";
import { parseVerificationCommand, stableVerificationDiagnostic } from "./verification-evidence";

const command = { executable: "bun", argv: ["test"], cwd: ".", exitCode: 0, signal: null,
  stdout: "", stderr: "", stdoutPreview: "", stderrPreview: "", captureAvailable: true,
  stdoutTruncated: false, stderrTruncated: false, timedOut: false, cancelled: false, durationMs: 12 };
const check = { id: "test", label: "Tests", required: true, kind: "command" as const,
  category: "test" as const, parser: "bun_test" as const, command: { executable: "bun", argv: ["test"] } };
test("a worker saying passed cannot turn a failed command into objective success", () => {
  expect(parseVerificationCommand(check, { ...command, exitCode: 1, stderr: "All tests passed" }).status).toBe("failed");
});
test("Bun zero executed tests, skipped-only tests and absent counts are insufficient", () => {
  for (const stderr of ["0 pass\n0 fail\nRan 0 tests across 0 files.", "0 pass\n3 skip\n0 fail\nRan 3 tests across 1 file.", "Tests all passed!"]) {
    expect(parseVerificationCommand(check, { ...command, stderr }).status).toBe("inconclusive");
  }
});
test("Bun reports require consistent real executed counts and no failures", () => {
  expect(parseVerificationCommand(check, { ...command, stderr: "2 pass\n0 fail\nRan 2 tests across 1 file. [2ms]" })).toMatchObject({ status: "passed", counts: { tests: 2, passed: 2, failed: 0, skipped: 0 } });
  expect(parseVerificationCommand(check, { ...command, stderr: "2 pass\n0 fail\nRan 3 tests across 1 file." }).status).toBe("inconclusive");
  expect(parseVerificationCommand(check, { ...command, stderr: "2 pass\n1 fail\nRan 3 tests across 1 file." }).status).toBe("failed");
});
test("test commands cannot bypass counting with an exit-code-only parser", () => {
  expect(parseVerificationCommand({ ...check, parser: "exit_code" }, command).status).toBe("inconclusive");
  expect(parseVerificationCommand({ ...check, category: "typecheck", parser: "exit_code" }, command).status).toBe("passed");
});
test("TAP plan and numbered records must agree, with executed assertions", () => {
  const tap = { ...check, parser: "tap" as const };
  expect(parseVerificationCommand(tap, { ...command, stdout: "TAP version 13\nok 1 - one\nok 2 - two\n1..2\n" }).status).toBe("passed");
  expect(parseVerificationCommand(tap, { ...command, stdout: "TAP version 13\nok 1 - one\n1..2\n" }).status).toBe("inconclusive");
  expect(parseVerificationCommand(tap, { ...command, stdout: "TAP version 13\nok 1 - skipped # SKIP\n1..1\n" }).status).toBe("inconclusive");
});
test("a timeout or signal cannot pass even with a successful-looking report", () => {
  expect(parseVerificationCommand(check, { ...command, timedOut: true, stderr: "1 pass\n0 fail\nRan 1 test across 1 file." }).reason).toBe("verification_timeout");
  expect(parseVerificationCommand(check, { ...command, signal: "SIGTERM" }).status).toBe("inconclusive");
});
test("failure signatures ignore runner timing but preserve assertion values and frames", () => {
  const left="Expected: 42\nReceived: 0\n at result.test.ts:12\n(fail) result [11.23ms]\nRan 1 test across 1 file. [0.12s]\n2026-11-08T01:23:45.123Z";
  const right=left.replace("11.23ms","9.11ms").replace("0.12s","0.09s").replace("01:23:45.123Z","01:23:46.456Z");
  expect(stableVerificationDiagnostic(left)).toBe(stableVerificationDiagnostic(right));
  expect(stableVerificationDiagnostic(left)).not.toBe(stableVerificationDiagnostic(left.replace("Received: 0","Received: 1")));
  expect(stableVerificationDiagnostic(left)).toContain("result.test.ts:12");
});
