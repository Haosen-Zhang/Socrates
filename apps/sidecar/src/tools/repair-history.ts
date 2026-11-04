import type { Database } from "bun:sqlite";
import type { ConversationMemoryStore } from "../store/conversation-memory-store";
import { deniedToolOutcome, interruptedToolOutcome } from "./recovery-outcome";

/** Repair through the same HistoryStore-backed writer as live tool exchanges. */
export async function repairToolHistory(db: Database, memory: ConversationMemoryStore, threadId: string): Promise<void> {
  const rows = db.query<{
    id: string; session_id: string; task_id: string; turn_id: string; agent_id: string;
    name: string; input_json: string; preview_text: string; byte_size: number; truncated: number; is_error: number;
    owning_run_id: string; owning_turn_id: string;
  }, [string]>(`SELECT tool_calls.*, tool_outputs.*, agent_runs.id AS owning_run_id,
      agent_runs.turn_id AS owning_turn_id FROM tool_calls
    JOIN tool_outputs ON tool_outputs.tool_call_id = tool_calls.id
    JOIN agent_runs ON agent_runs.session_id = tool_calls.session_id AND
      (agent_runs.id = tool_calls.task_id OR agent_runs.runtime_session_id IN
        (SELECT id FROM runtime_sessions WHERE agent_session_id = tool_calls.task_id))
    WHERE agent_runs.thread_id = ?
      AND NOT EXISTS (SELECT 1 FROM session_messages
        WHERE thread_id = agent_runs.thread_id AND idempotency_key = 'tool-result:' || agent_runs.id || ':' || tool_calls.id)
    ORDER BY tool_calls.created_at, tool_calls.rowid`).all(threadId);
  for (const row of rows) {
    const common = { roomId: row.session_id, threadId, runId: row.owning_run_id, turnId: row.owning_turn_id, agentId: row.agent_id };
    const callKey = `tool-call:${row.owning_run_id}:${row.id}`;
    if (!db.query("SELECT 1 FROM session_messages WHERE thread_id = ? AND idempotency_key = ?").get(threadId, callKey)) {
      await memory.appendMessage({ ...common, role: "assistant", kind: "tool_call", content: "",
        parts: [{ type: "tool_call", callId: row.id, name: row.name, input: JSON.parse(row.input_json) }],
        status: "completed", idempotencyKey: callKey });
    }
    const output = { preview: row.preview_text, byteSize: row.byte_size, truncated: row.truncated === 1 };
    await memory.appendMessage({ ...common, role: "tool", kind: "tool_result", content: row.preview_text,
      parts: [{ type: "tool_result", callId: row.id, output, isError: row.is_error === 1 }],
      status: row.is_error ? "failed" : "completed", idempotencyKey: `tool-result:${row.owning_run_id}:${row.id}` });
  }

  // The SDK can publish a tool call and wait for approval before the executor
  // receives it. No operation row means the body never crossed its checkpoint.
  const pending = db.query<{
    room_id: string; run_id: string; turn_id: string; agent_id: string; tool_call_id: string; denied: number;
  }, [string]>(`SELECT messages.session_id AS room_id, messages.run_id, messages.turn_id, messages.agent_id, parts.tool_call_id,
      EXISTS (SELECT 1 FROM runtime_events AS events
        JOIN approval_requests AS requests ON requests.id = json_extract(events.payload_json, '$.requestId')
        WHERE events.run_id = messages.run_id AND events.type = 'approval.requested'
          AND json_extract(events.payload_json, '$.callId') = parts.tool_call_id AND requests.status = 'denied') AS denied
    FROM session_messages AS messages
    JOIN message_parts AS parts ON parts.message_id = messages.id
    JOIN agent_runs ON agent_runs.id = messages.run_id
    WHERE messages.thread_id = ? AND parts.type = 'tool_call'
      AND agent_runs.status IN ('completed', 'failed', 'cancelled', 'interrupted')
      AND NOT EXISTS (SELECT 1 FROM tool_calls WHERE id = parts.tool_call_id)
      AND NOT EXISTS (SELECT 1 FROM message_parts AS results
        JOIN session_messages AS result_messages ON result_messages.id = results.message_id
        WHERE result_messages.thread_id = messages.thread_id AND result_messages.run_id = messages.run_id
          AND results.type = 'tool_result' AND results.tool_call_id = parts.tool_call_id)`).all(threadId);
  for (const call of pending) {
    const preview = JSON.stringify(call.denied ? deniedToolOutcome() : interruptedToolOutcome(false, "non_idempotent", null));
    await memory.appendMessage({ roomId: call.room_id, threadId, runId: call.run_id, turnId: call.turn_id, agentId: call.agent_id,
      role: "tool", kind: "tool_result", content: preview,
      parts: [{ type: "tool_result", callId: call.tool_call_id, output: { preview, byteSize: Buffer.byteLength(preview), truncated: false }, isError: true }],
      status: "failed", idempotencyKey: `tool-result:${call.run_id}:${call.tool_call_id}` });
  }
}
