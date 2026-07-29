import { describe, expect, it } from "bun:test";
import type { ConversationStoredMessage, MessagePart, StoredMessageKind, StoredMessageRole } from "@socrates/core";
import { buildConversationContext } from "./conversation-context";

function message(
  sequence: number,
  role: StoredMessageRole,
  content: string,
  options: { kind?: StoredMessageKind; parts?: MessagePart[] } = {},
): ConversationStoredMessage {
  return {
    messageId: `m-${sequence}`,
    roomId: "room",
    threadId: "thread",
    runId: "run",
    turnId: `turn-${sequence}`,
    agentId: role === "user" ? null : "agent",
    role,
    kind: options.kind ?? "text",
    content,
    parts: options.parts ?? [{ type: "text", text: content }],
    sequence,
    createdAt: new Date(sequence).toISOString(),
    status: "completed",
    idempotencyKey: `message-${sequence}`,
  };
}

describe("buildConversationContext", () => {
  it("truncates by estimated tokens while retaining instructions and the latest complete exchange", () => {
    const history = [
      message(1, "system", "Always be precise."),
      message(2, "user", "old ".repeat(300)),
      message(3, "assistant", "old answer ".repeat(300)),
      message(4, "user", "current question"),
    ];
    const context = buildConversationContext(history, {
      contextWindowTokens: 120,
      outputReserveTokens: 20,
    });
    expect(context.truncated).toBe(true);
    expect(context.messages.map((item) => item.messageId)).toEqual(["m-1", "m-4"]);
    expect(context.droppedThroughSequence).toBe(3);
  });

  it("never separates a tool call from its corresponding result", () => {
    const history = [
      message(1, "user", "old ".repeat(200)),
      message(2, "assistant", "", {
        kind: "tool_call",
        parts: [{ type: "tool_call", callId: "call", name: "read_file", input: { path: "a" } }],
      }),
      message(3, "tool", "", {
        kind: "tool_result",
        parts: [{
          type: "tool_result",
          callId: "call",
          output: { preview: "result ".repeat(20), byteSize: 140, truncated: false },
          isError: false,
        }],
      }),
      message(4, "user", "what did it say?"),
    ];
    for (const window of [80, 140, 240]) {
      const ids = buildConversationContext(history, {
        contextWindowTokens: window,
        outputReserveTokens: 20,
      }).messages.map((item) => item.messageId);
      expect(ids.includes("m-2")).toBe(ids.includes("m-3"));
      expect(ids).toContain("m-4");
    }
  });

  it("keeps interleaved parallel tool calls and results as one atomic context unit", () => {
    const history = [
      message(1, "user", "old ".repeat(200)),
      message(2, "assistant", "", {
        kind: "tool_call",
        parts: [{ type: "tool_call", callId: "one", name: "read_file", input: { path: "a" } }],
      }),
      message(3, "assistant", "", {
        kind: "tool_call",
        parts: [{ type: "tool_call", callId: "two", name: "read_file", input: { path: "b" } }],
      }),
      message(4, "tool", "", {
        kind: "tool_result",
        parts: [{
          type: "tool_result",
          callId: "one",
          output: { preview: "a", byteSize: 1, truncated: false },
          isError: false,
        }],
      }),
      message(5, "tool", "", {
        kind: "tool_result",
        parts: [{
          type: "tool_result",
          callId: "two",
          output: { preview: "b", byteSize: 1, truncated: false },
          isError: false,
        }],
      }),
      message(6, "user", "continue"),
    ];
    for (const window of [90, 140, 220]) {
      const ids = buildConversationContext(history, {
        contextWindowTokens: window,
        outputReserveTokens: 20,
      }).messages.map((item) => item.messageId);
      const toolIds = ["m-2", "m-3", "m-4", "m-5"].filter((id) => ids.includes(id));
      expect(toolIds.length === 0 || toolIds.length === 4).toBe(true);
    }
  });

  it("does not truncate when the Thread is within the model budget", () => {
    const history = [
      message(1, "user", "hello"),
      message(2, "assistant", "hi"),
      message(3, "user", "remember me"),
    ];
    const context = buildConversationContext(history, {
      contextWindowTokens: 4_096,
      outputReserveTokens: 512,
    });
    expect(context.truncated).toBe(false);
    expect(context.messages.map((item) => item.content)).toEqual(["hello", "hi", "remember me"]);
  });
});
