import { normalizeWorkspaceRelativePath } from "./workspace";

export type ToolOutputRef = { preview: string; storageKey?: string; byteSize: number; truncated: boolean };
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "image"; attachmentId: string; mediaType: string; alt?: string }
  | { type: "file"; attachmentId: string; mediaType: string; filename: string }
  | { type: "workspace_ref"; refId: string; relativePath: string; snapshotHash?: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; output: ToolOutputRef; isError: boolean }
  | { type: "reasoning_summary"; text: string };

export interface AttachmentRecord {
  id: string;
  sha256: string;
  mediaType: string;
  filename: string;
  byteSize: number;
  status: "ready" | "failed";
  createdAt: string;
}

export function validateMessageParts(parts: readonly MessagePart[]): string[] {
  if (!parts.length) return ["message_parts_required"];
  const errors: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && !part.text.trim()) errors.push("empty_text_part");
    if ((part.type === "image" || part.type === "file") && !part.attachmentId) errors.push("attachment_id_required");
    if (part.type === "workspace_ref") {
      try {
        if (normalizeWorkspaceRelativePath(part.relativePath) !== part.relativePath) errors.push("workspace_ref_noncanonical_path");
      } catch {
        errors.push("workspace_ref_invalid_path");
      }
    }
  }
  return errors;
}
