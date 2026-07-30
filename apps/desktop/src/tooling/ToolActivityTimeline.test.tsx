import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalShelf, ToolActivityTimeline } from "./ToolActivityTimeline";

describe("ToolActivityTimeline accessibility", () => {
  it("uses a native collapsed disclosure so keyboard users can inspect details", () => {
    const markup = renderToStaticMarkup(
      <ToolActivityTimeline activities={[{
        id: "run:call",
        callId: "call",
        name: "read_file",
        input: { path: "README.md" },
        operation: "read",
        subject: "README.md",
        readOnly: true,
        isError: false,
        status: "succeeded",
        sequence: 1,
        runId: "run",
        turnId: "turn",
      }]} />,
    );

    expect(markup).toContain("<details");
    expect(markup).toContain("<summary");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("README.md");
  });

  it("keeps visible keyboard focus and disables the thinking animation for reduced motion", async () => {
    const css = await Bun.file(new URL("../index.css", import.meta.url)).text();
    expect(css).toContain(".tool-activity-summary:focus-visible");
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*\.thinking-pixel\s*\{\s*animation:\s*none;/);
  });

  it("identifies the concrete operation, target, workspace, risk reason, and decisions", () => {
    const markup = renderToStaticMarkup(
      <ApprovalShelf
        approvals={[{
          id: "approval",
          kind: "command_execution",
          subjectId: "run:provider-request",
          risk: "high",
          freshHumanRequired: false,
          status: "pending",
        }]}
        activities={[{
          id: "run:call",
          callId: "call",
          name: "run_shell",
          input: { command: "git", args: "status --short" },
          operation: "command",
          subject: "git status --short",
          readOnly: false,
          isError: false,
          status: "requested",
          approvalId: "approval",
          risk: "high",
          sequence: 1,
          runId: "run",
          turnId: "turn",
        }]}
        workspaceLabel="Socrates"
        busy={false}
        onDecision={async () => {}}
      />,
    );

    expect(markup).toContain("git status --short");
    expect(markup).toContain("Socrates");
    expect(markup).toContain("该操作会在本机工作区运行命令");
    expect(markup).toContain("允许一次");
    expect(markup).toContain("本会话允许");
    expect(markup).toContain("拒绝");
  });
});
