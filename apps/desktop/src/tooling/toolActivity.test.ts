import { describe, expect, it } from "bun:test";
import type { RuntimeEvent, SessionMessage } from "@socrates/core";
import {
  approvalReasonKey,
  describeToolCall,
  projectPublicReasoning,
  projectToolActivities,
  safeTechnicalJson,
} from "./toolActivity";

function message(
  input: Partial<SessionMessage> & Pick<SessionMessage, "id" | "role" | "kind" | "sequence" | "parts">,
): SessionMessage {
  return {
    sessionId: "session",
    authorId: "agent",
    content: "",
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    runId: "run",
    turnId: "turn",
    ...input,
    turnStatus: input.turnStatus ?? null,
  };
}

describe("tool activity projection", () => {
  it("pairs a persisted call and result once, even when replayed live events overlap", () => {
    const messages: SessionMessage[] = [
      message({
        id: "call-message",
        role: "assistant",
        kind: "tool_call",
        sequence: 2,
        createdAt: "2026-01-01T00:00:01.000Z",
        parts: [{ type: "tool_call", callId: "call-1", name: "read_file", input: { path: "README.md" } }],
      }),
      message({
        id: "result-message",
        role: "tool",
        kind: "tool_result",
        sequence: 3,
        createdAt: "2026-01-01T00:00:02.250Z",
        parts: [{
          type: "tool_result",
          callId: "call-1",
          output: { preview: "hello", byteSize: 5, truncated: false },
          isError: false,
        }],
      }),
    ];
    const events: RuntimeEvent[] = [
      { type: "tool_call", callId: "call-1", name: "read_file", input: { path: "README.md" } },
      {
        type: "tool_result",
        callId: "call-1",
        name: "read_file",
        output: { preview: "hello", byteSize: 5, truncated: false },
        isError: false,
      },
    ];

    const activities = projectToolActivities({ messages, events, approvals: [], activeRunId: "run" });

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      callId: "call-1",
      name: "read_file",
      operation: "read",
      subject: "README.md",
      status: "succeeded",
      durationMs: 1_250,
      readOnly: true,
    });
    expect(activities[0]?.output?.preview).toBe("hello");
  });

  it("correlates a durable approval through approval_required requestId and callId", () => {
    const events: RuntimeEvent[] = [
      {
        type: "tool_call",
        callId: "call-2",
        name: "write_file",
        input: { path: "src/app.ts", content: "secret" },
      },
      {
        type: "approval_required",
        requestId: "approval-2",
        callId: "call-2",
        risk: "high",
        kind: "tool",
      },
    ];

    const activities = projectToolActivities({
      messages: [],
      events,
      approvals: [{
        id: "approval-2",
        kind: "tool",
        subjectId: "run:provider-approval-id",
        risk: "high",
        freshHumanRequired: true,
        status: "pending",
      }],
    });

    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      callId: "call-2",
      operation: "write",
      subject: "src/app.ts",
      status: "requested",
      approvalId: "approval-2",
      readOnly: false,
    });
  });

  it("settles unresolved calls deterministically when a run fails or is cancelled", () => {
    const call: RuntimeEvent = {
      type: "tool_call",
      callId: "call-3",
      name: "run_shell",
      input: { executable: "git", argv: ["status", "--short"] },
    };
    expect(projectToolActivities({
      messages: [],
      events: [call, { type: "status", status: "failed", message: "provider_failed" }],
      approvals: [],
    })[0]?.status).toBe("failed");
    expect(projectToolActivities({
      messages: [],
      events: [call, { type: "status", status: "interrupted" }],
      approvals: [],
    })[0]?.status).toBe("cancelled");
  });

  it("keeps a reused provider call ID isolated by Run", () => {
    const messages: SessionMessage[] = [
      message({
        id: "run-1-call",
        role: "assistant",
        kind: "tool_call",
        runId: "run-1",
        sequence: 1,
        parts: [{ type: "tool_call", callId: "call", name: "read_file", input: { path: "one.md" } }],
      }),
      message({
        id: "run-1-result",
        role: "tool",
        kind: "tool_result",
        runId: "run-1",
        sequence: 2,
        parts: [{
          type: "tool_result",
          callId: "call",
          output: { preview: "one", byteSize: 3, truncated: false },
          isError: false,
        }],
      }),
      message({
        id: "run-2-call",
        role: "assistant",
        kind: "tool_call",
        runId: "run-2",
        sequence: 3,
        parts: [{ type: "tool_call", callId: "call", name: "write_file", input: { path: "two.md" } }],
      }),
    ];

    const activities = projectToolActivities({ messages, events: [], approvals: [] });
    expect(activities).toHaveLength(2);
    expect(activities.map((activity) => ({
      id: activity.id,
      subject: activity.subject,
      status: activity.status,
    }))).toEqual([
      { id: "run-1:call", subject: "one.md", status: "succeeded" },
      { id: "run-2:call", subject: "two.md", status: "running" },
    ]);
  });

  it("returns an approved pending call to running until its result arrives", () => {
    const activities = projectToolActivities({
      messages: [],
      events: [
        { type: "tool_call", callId: "call", name: "write_file", input: { path: "file.md" } },
        { type: "approval_required", requestId: "approval", callId: "call", risk: "medium" },
      ],
      approvals: [],
      activeRunId: "run",
    });
    expect(activities[0]?.status).toBe("running");
  });
});

describe("human-readable and safe tool details", () => {
  it("describes built-in operations without exposing raw JSON in the summary", () => {
    expect(describeToolCall("search_text", { query: "TODO" })).toEqual({
      operation: "search",
      subject: "TODO",
      readOnly: true,
    });
    expect(describeToolCall("run_shell", { executable: "git", argv: ["status", "--short"] })).toEqual({
      operation: "command",
      subject: "git status --short",
      readOnly: false,
    });
    expect(describeToolCall("delete_path", { path: "tmp/output.txt" })).toEqual({
      operation: "delete",
      subject: "tmp/output.txt",
      readOnly: false,
    });
    expect(describeToolCall("copy_path", { source: "draft", destination: "backup" })).toEqual({
      operation: "write",
      subject: "draft → backup",
      readOnly: false,
    });
    expect(describeToolCall("move_path", { source: "old.md", destination: "new.md" })).toEqual({
      operation: "delete",
      subject: "old.md → new.md",
      readOnly: false,
    });
    expect(describeToolCall("create_document", { path: "report.docx" })).toEqual({
      operation: "write",
      subject: "report.docx",
      readOnly: false,
    });
    expect(describeToolCall("run_shell", { executable: "echo", argv: ["hello world"] }).subject)
      .toBe('echo "hello world"');
  });

  it("explains why the concrete operation requires approval", () => {
    expect(approvalReasonKey("write", "medium")).toBe("approval_reason_write");
    expect(approvalReasonKey("command", "high")).toBe("approval_reason_command");
    expect(approvalReasonKey("tool", "destructive")).toBe("approval_risk_destructive");
  });

  it("redacts secret keys and credential-shaped strings in expandable details", () => {
    const rendered = safeTechnicalJson({
      path: "config.json",
      apiKey: "sk-super-secret",
      nested: { authorization: "Bearer abc.def.ghi" },
      command: "curl -H 'Authorization: Bearer token-value'",
    });
    expect(rendered).toContain("config.json");
    expect(rendered).toContain("[REDACTED]");
    expect(rendered).not.toContain("sk-super-secret");
    expect(rendered).not.toContain("abc.def.ghi");
    expect(rendered).not.toContain("token-value");
  });
});

describe("public reasoning projection", () => {
  it("restores explicit summaries and appends only explicit public-summary events", () => {
    const summaries = projectPublicReasoning({
      messages: [message({
        id: "summary",
        role: "assistant",
        kind: "summary",
        sequence: 4,
        parts: [{ type: "reasoning_summary", text: "Checked the workspace constraints." }],
      })],
      events: [{
        type: "extension",
        name: "reasoning_summary_delta",
        payload: { text: " Then compared the options." },
      }],
      running: true,
      activeRunId: "run",
    });

    expect(summaries).toEqual([{
      id: "summary",
      text: "Checked the workspace constraints. Then compared the options.",
      running: true,
    }]);
  });

  it("does not fabricate hidden reasoning when no public summary exists", () => {
    expect(projectPublicReasoning({
      messages: [],
      events: [{ type: "extension", name: "reasoning_delta", payload: { text: "hidden" } }],
      running: true,
    })).toEqual([]);
  });

  it("restores every persisted public summary and ignores stale live deltas after completion", () => {
    const summaries = projectPublicReasoning({
      messages: [
        message({
          id: "summary-1",
          role: "assistant",
          kind: "summary",
          runId: "run-1",
          sequence: 1,
          parts: [{ type: "reasoning_summary", text: "First public summary." }],
        }),
        message({
          id: "summary-2",
          role: "assistant",
          kind: "summary",
          runId: "run-2",
          sequence: 2,
          parts: [{ type: "reasoning_summary", text: "Second public summary." }],
        }),
      ],
      events: [{
        type: "extension",
        name: "reasoning_summary_delta",
        payload: { text: "Second public summary." },
      }],
      running: false,
    });
    expect(summaries.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "summary-1", text: "First public summary." },
      { id: "summary-2", text: "Second public summary." },
    ]);
  });
});
