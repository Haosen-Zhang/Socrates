import type { CheckEvidence, VerificationCheck } from "@socrates/core";
import type { StructuredCommandResult } from "../tools/workspace-command-runner";

type Parsed = Pick<CheckEvidence, "status" | "reason" | "counts">;
/** Parse runner summaries, never the executor's narrative. Exit state and test
 * counts are separate conditions; missing/unsupported reports remain unknown. */
export function parseVerificationCommand(check: Extract<VerificationCheck, { kind: "command" }>, result: StructuredCommandResult, output?: string): Parsed {
  if (result.timedOut) return { status: "inconclusive", reason: "verification_timeout" };
  if (result.cancelled || result.signal) return { status: "inconclusive", reason: "verification_cancelled" };
  if (result.exitCode !== 0) return { status: "failed", reason: "verification_nonzero_exit" };
  if (check.category !== "test" && check.parser === "exit_code") return { status: "passed", reason: "command_exit_zero" };
  const text = output ?? `${result.stdout}\n${result.stderr}`;
  let counts: CheckEvidence["counts"];
  if (check.parser === "bun_test") {
    const value = (name: string): number | undefined => {
      const matches = [...text.matchAll(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, "gm"))];
      return matches.length ? Number(matches.at(-1)![1]) : undefined;
    };
    const passed = value("pass"), failed = value("fail"), skipped = value("skip") ?? 0;
    const summaries = [...text.matchAll(/^Ran (\d+) tests? across \d+ files?\./gm)];
    const tests = summaries.length ? Number(summaries.at(-1)![1]) : undefined;
    if (passed !== undefined && failed !== undefined && tests !== undefined && tests === passed + failed + skipped) counts = { tests, passed, failed, skipped };
  } else if (check.parser === "tap") {
    const plans = [...text.matchAll(/^1\.\.(\d+)(?:\s+#.*)?\s*$/gm)];
    const rows = [...text.matchAll(/^(not ok|ok) (\d+)(?:\s*[-:].*)?$/gm)];
    const tests = plans.length === 1 ? Number(plans[0]![1]) : -1;
    if (/^TAP version 13\s*$/m.test(text) && !/^Bail out!/mi.test(text) && tests === rows.length && rows.every((row, index) => Number(row[2]) === index + 1)) {
      const skipped = rows.filter(row => /#\s*(?:SKIP|TODO)\b/i.test(row[0])).length;
      const failed = rows.filter(row => row[1] === "not ok" && !/#\s*(?:SKIP|TODO)\b/i.test(row[0])).length;
      counts = { tests, skipped, failed, passed: tests - skipped - failed };
    }
  } else return { status: "inconclusive", reason: "verification_parser_unavailable" };
  if (!counts) return { status: "inconclusive", reason: "verification_report_invalid" };
  if (counts.failed) return { status: "failed", reason: "verification_test_failures", counts };
  if (counts.passed < (check.minTests ?? 1)) return { status: "inconclusive", reason: "verification_no_tests_executed", counts };
  return { status: "passed", reason: "test_report_passed", counts };
}
