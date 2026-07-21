import type { RuntimeEvent } from "@socrates/core";

/**
 * 单 agent 流式事件分类（P0.2）。
 * - text：高频文本增量，累积进 agentStreamText，用 rAF 批处理，不逐个入 store 数组。
 * - control：错误/完成/取消/审批/工具状态等，必须保序且即时——落盘前先 flush 待处理文本。
 */
export type RuntimeEventClass = "text" | "control";

export function classifyRuntimeEvent(event: RuntimeEvent): RuntimeEventClass {
  return event.type === "text_delta" ? "text" : "control";
}

/** 从 text_delta 取增量文本；非文本事件返回空串。 */
export function deltaText(event: RuntimeEvent): string {
  return event.type === "text_delta" ? event.text : "";
}
