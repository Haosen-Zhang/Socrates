import { describe, expect, it } from "bun:test";
import type { RuntimeEvent } from "@socrates/core";
import { classifyRuntimeEvent, deltaText } from "./agentStream";

const text = (t: string): RuntimeEvent => ({ type: "text_delta", text: t });

describe("classifyRuntimeEvent", () => {
  it("only text_delta is high-frequency; everything else is control", () => {
    expect(classifyRuntimeEvent(text("hi"))).toBe("text");
    expect(classifyRuntimeEvent({ type: "usage", usage: {} as never })).toBe("control");
    expect(classifyRuntimeEvent({ type: "tool_call", callId: "c", name: "read", input: {} })).toBe("control");
    expect(classifyRuntimeEvent({ type: "approval_required", requestId: "r", callId: "c" })).toBe("control");
    expect(classifyRuntimeEvent({ type: "status", status: "completed" })).toBe("control");
    expect(classifyRuntimeEvent({ type: "extension", name: "run_started", payload: {} })).toBe("control");
  });
});

describe("deltaText", () => {
  it("concatenation reproduces full text in order", () => {
    const events = [text("你"), text("好"), text("世界")];
    expect(events.map(deltaText).join("")).toBe("你好世界");
  });
  it("non-text events contribute nothing", () => {
    expect(deltaText({ type: "status", status: "running" })).toBe("");
  });
});
