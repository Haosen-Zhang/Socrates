import type { Database } from "bun:sqlite";
import { StructuredExecutionError, type ToolDefinition } from "@socrates/core";
import type { CommandOutputCapture } from "./workspace-command-runner";

export type ToolOutputScope = { sessionId: string; workspaceIdentity: string };
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const REF = /^tool-result:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Private SQLite artifacts, never workspace paths. Incomplete captures are not
 * readable, and every retrieval checks the owning Session AND workspace. */
export class ToolOutputStore {
  constructor(private readonly db: Database) {}

  private capture(scope: ToolOutputScope, operationId?: string, mediaType = "text/plain") {
    const id = crypto.randomUUID(); let size = 0; let ordinal = 0; let complete = false;
    this.db.query(`INSERT INTO tool_result_artifacts (id, session_id, workspace_identity, tool_operation_id, media_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, scope.sessionId, scope.workspaceIdentity, operationId ?? null, mediaType, new Date().toISOString());
    return {
      write: (bytes: Uint8Array) => {
        if (complete) throw new Error("tool_output_capture_closed");
        if (size + bytes.byteLength > MAX_ARTIFACT_BYTES) throw new StructuredExecutionError({
          code: "TOOL_OUTPUT_LIMIT", category: "tool_execution", phase: "tool_execution", retryable: false,
          message: "Tool output exceeded the 64 MiB per-stream storage limit; execution stopped.",
        });
        this.db.transaction(() => {
          for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
            const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
            this.db.query("INSERT INTO tool_result_chunks (artifact_id, ordinal, byte_offset, byte_size, bytes) VALUES (?, ?, ?, ?, ?)")
              .run(id, ordinal++, size, chunk.byteLength, chunk);
            size += chunk.byteLength;
          }
          this.db.query("UPDATE tool_result_artifacts SET byte_size = ? WHERE id = ?").run(size, id);
        })();
      },
      finish: () => {
        this.db.query("UPDATE tool_result_artifacts SET complete = 1 WHERE id = ?").run(id);
        complete = true; return `tool-result:${id}`;
      },
    };
  }

  put(scope: ToolOutputScope, value: string, operationId?: string): string {
    return this.db.transaction(() => {
      const capture = this.capture(scope, operationId, "application/json");
      capture.write(new TextEncoder().encode(value));
      return capture.finish();
    })();
  }

  createCommandCapture(scope: ToolOutputScope, operationId?: string): CommandOutputCapture {
    const stdout = this.capture(scope, operationId); const stderr = this.capture(scope, operationId);
    return { write(stream, chunk) { (stream === "stdout" ? stdout : stderr).write(chunk); },
      finish() { return { stdout: stdout.finish(), stderr: stderr.finish() }; } };
  }

  read(scope: ToolOutputScope, ref: string, offset = 0, maxBytes = 16 * 1024) {
    const id = REF.exec(ref)?.[1];
    if (!id) throw new Error("invalid_tool_output_ref");
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(maxBytes) || maxBytes < 4 || maxBytes > 32 * 1024) {
      throw new Error("invalid_tool_output_range");
    }
    const row = this.db.query<{ byte_size: number }, [string, string, string]>(`SELECT byte_size FROM tool_result_artifacts
      WHERE id = ? AND session_id = ? AND workspace_identity = ? AND complete = 1`).get(id, scope.sessionId, scope.workspaceIdentity);
    if (!row) throw new Error("tool_output_not_found");
    if (offset > row.byte_size) throw new Error("invalid_tool_output_range");
    const end = Math.min(row.byte_size, offset + maxBytes);
    const chunks = this.db.query<{ byte_offset: number; bytes: Uint8Array }, [string, number, number]>(`SELECT byte_offset, bytes
      FROM tool_result_chunks WHERE artifact_id = ? AND byte_offset < ? AND byte_offset + byte_size > ? ORDER BY ordinal`)
      .all(id, end, offset);
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.bytes).subarray(Math.max(0, offset - chunk.byte_offset), end - chunk.byte_offset)));
    // Keep a returned continuation on a UTF-8 boundary; output itself can still
    // contain binary bytes, which are decoded with replacement for model safety.
    let length = bytes.length;
    if (end < row.byte_size) {
      let start = length - 1;
      while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start--;
      const first = bytes[start] ?? 0;
      const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
      if (start >= 0 && length - start < width) length = start;
    }
    return { ref, text: bytes.subarray(0, length).toString("utf-8"), byteSize: row.byte_size,
      offset, nextOffset: offset + length, truncated: offset + length < row.byte_size };
  }
}

export function createToolResultReader(store: ToolOutputStore, scope: ToolOutputScope): ToolDefinition {
  return {
    name: "read_tool_result", description: "Read a bounded UTF-8 page from a full tool result reference belonging to this room and workspace. Offsets are bytes; continue with nextOffset.",
    inputSchema: { type: "object", additionalProperties: false, required: ["ref"], properties: {
      ref: { type: "string", description: "Opaque tool-result reference returned by a previous tool; never a filesystem path." },
      offset: { type: "integer", minimum: 0, description: "Byte offset, usually the previous nextOffset." },
      maxBytes: { type: "integer", minimum: 4, maximum: 32768, description: "Page size; defaults to 16384 bytes." },
    }, examples: [{ ref: "tool-result:12345678-1234-1234-1234-123456789abc", offset: 0, maxBytes: 16384 }] },
    outputSchema: { type: "object", additionalProperties: false, required: ["ref", "text", "byteSize", "offset", "nextOffset", "truncated"], properties: {
      ref: { type: "string" }, text: { type: "string" }, byteSize: { type: "integer", minimum: 0 },
      offset: { type: "integer", minimum: 0 }, nextOffset: { type: "integer", minimum: 0 }, truncated: { type: "boolean" },
    } }, risk: "low", capability: "workspace_read", idempotency: "read", generation: 1, timeoutMs: 30_000,
    async execute(input) {
      const { ref, offset, maxBytes } = input as { ref: string; offset?: number; maxBytes?: number };
      return store.read(scope, ref, offset, maxBytes);
    },
  };
}
