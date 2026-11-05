import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConversationSession } from "@socrates/core";
import type { MultiTaskView } from "./store";
import TeamTaskPanel from "./TeamTaskPanel";

const session = {
  agents: [
    { agentId: "a", snapshot: { nickname: "Builder" } },
    { agentId: "b", snapshot: { nickname: "Tester" } },
  ],
} as unknown as ConversationSession;
const first = {
  id: "task/one",
  taskId: "task",
  title: "Implement parser",
  objective: "Handle input",
  input: "",
  dependencies: [],
  executorAgentId: "a",
  reviewerAgentId: null,
  expectedFiles: ["parser.ts"],
  acceptanceCriteria: ["Valid input works"],
  state: "completed",
  attemptNo: 1,
  runId: "r1",
  result: "Parser implemented",
  failureReason: null,
} as const;

describe("team task panel", () => {
  it("shows actual owners, blocked dependencies and workspace queuing without declaring success", () => {
    const task = {
      id: "task",
      state: "executing",
      workPackages: [
        first,
        {
          ...first,
          id: "task/two",
          title: "Verify parser",
          executorAgentId: "b",
          dependencies: ["task/one"],
          state: "ready",
          result: null,
          queueReason: "workspace_write_lease_busy",
        },
      ],
    } as unknown as MultiTaskView;
    const html = renderToStaticMarkup(
      <TeamTaskPanel task={task} session={session} />,
    );
    expect(html).toContain("Builder");
    expect(html).toContain("Tester");
    expect(html).toContain("Verify parser");
    expect(html).toContain("依赖");
    expect(html).toContain("Implement parser");
    expect(html).toContain("正在等待同工作区的写入任务完成");
  });
  it("renders a readable partial-completion summary instead of raw records", () => {
    const task = {
      id: "task",
      state: "paused",
      workPackages: [first],
      summary: {
        completed: [
          {
            id: first.id,
            title: first.title,
            agentId: "a",
            result: first.result,
          },
        ],
        unfinished: [
          {
            id: "task/two",
            title: "Verify parser",
            state: "budget_stopped",
            reason: "Step budget exhausted",
          },
        ],
        verification: [
          {
            packageId: first.id,
            acceptanceCriteria: [],
            reviewerAgentId: null,
            reviewNotes: null,
            result: "Unit checks passed",
          },
        ],
        artifacts: [{ packageId: first.id, path: "parser.ts", reported: true }],
      },
    } as unknown as MultiTaskView;
    const html = renderToStaticMarkup(
      <TeamTaskPanel task={task} session={session} />,
    );
    expect(html).toContain("未完成");
    expect(html).toContain("预算停止");
    expect(html).toContain("Unit checks passed");
    expect(html).toContain("parser.ts");
    expect(html).not.toContain("packageId");
    expect(html).not.toContain("agentId");
  });
});

it("requires a per-package review confirmation before retrying an unknown outcome", () => {
  const task = {
    id: "unknown-task",
    state: "paused",
    workPackages: [
      {
        ...first,
        state: "failed",
        result: "Last saved result",
        failureReason: "execution_outcome_unknown",
      },
    ],
  } as unknown as MultiTaskView;
  const html = renderToStaticMarkup(
    <TeamTaskPanel task={task} session={session} />,
  );
  expect(html).toContain('id="team-packages-unknown-task"');
  expect(html).toContain('type="checkbox"');
  expect(html).toContain("我已检查工具记录和文件变化");
  expect(html).toContain("Last saved result");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>重试<\/button>/);
});
