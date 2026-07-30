/**
 * Protocol Decoder — Socrates Desktop
 *
 * 职责：验证 sidecar RuntimeEvent 的 schema，拒绝无效/未知事件。
 * 不包含：业务状态迁移、UI 投影。
 *
 * Phase 1 最小实现：type 字段检查 + 已知事件类型白名单。
 */
import type { RuntimeEvent } from "@socrates/core";

const KNOWN_EVENT_TYPES = new Set([
  "text_delta",
  "tool_call",
  "tool_result",
  "approval_required",
  "usage",
  "status",
  "extension",
]);

const KNOWN_EXTENSION_NAMES = new Set([
  "run_started",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "agent.state.changed",
  "turn.started",
  "assistant.delta",
  "tool.proposed",
  "tool.completed",
  "tool.failed",
  "reasoning_summary_delta",
]);

export type DecodedRuntimeEvent = RuntimeEvent & {
  /** 原始 payload（保留未识别字段） */
  _raw?: Record<string, unknown>;
};

/**
 * 验证并解码一个来自 SSE 的事件对象。
 * 返回值：DecodedRuntimeEvent | null（无效/未知事件返回 null 并 console.warn）
 */
export function decodeRuntimeEvent(raw: Record<string, unknown>): DecodedRuntimeEvent | null {
  // 状态事件（run_terminal）
  if ("status" in raw && typeof raw.status === "string" && !("type" in raw)) {
    return {
      type: "status",
      status: raw.status as RuntimeEvent extends { type: "status" } ? string : string,
      message: typeof raw.error === "string" ? raw.error : undefined,
      _raw: raw,
    } as DecodedRuntimeEvent;
  }

  // RuntimeEvent（有 type 字段）
  if (typeof raw.type === "string" && KNOWN_EVENT_TYPES.has(raw.type)) {
    const event = raw as unknown as DecodedRuntimeEvent;

    // extension 事件：检查 name 是否已知
    if (event.type === "extension" && typeof event.name === "string") {
      if (!KNOWN_EXTENSION_NAMES.has(event.name)) {
        console.warn(`[protocol] unknown extension event: ${event.name}`, raw);
        // 仍然放行，但标记
      }
    }

    event._raw = raw;
    return event;
  }

  if (typeof raw.type === "string") {
    console.warn(`[protocol] unknown event type: ${raw.type}`, raw);
    return null;
  }

  return null;
}
