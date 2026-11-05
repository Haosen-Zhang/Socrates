import type { Database } from "bun:sqlite";
import type { MessagePart } from "@socrates/core";
import type { AttachmentResolver } from "../attachments/resolver";
import type { WorkspaceManager } from "../workspace/manager";

export interface RoomFileContext { text: string; parts: MessagePart[] }
export function resolveRoomFileContext(db: Database, workspaces: WorkspaceManager, attachments: AttachmentResolver,
  workspaceId: string | null, refIds: string[], attachmentIds: string[]): RoomFileContext {
  if (!refIds.length && !attachmentIds.length) return { text: "", parts: [] };
  const workspace = workspaceId ? workspaces.get(workspaceId) : null;
  if (!workspace) throw new Error("file_context_workspace_required");
  const parts: MessagePart[] = [], blocks: string[] = [];
  const textOf = (id: string) => {
    const { record, bytes } = attachments.read(id);
    if (!record.mediaType.startsWith("text/") && record.mediaType !== "application/json") throw new Error("discussion_attachment_type_unsupported");
    if (bytes.byteLength > 256_000) throw new Error("discussion_attachment_context_too_large");
    return { record, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  };
  for (const id of [...new Set(refIds)]) {
    const reference = db.query<{ workspace_id: string; relative_path: string; snapshot_hash: string | null }, [string]>("SELECT workspace_id,relative_path,snapshot_hash FROM workspace_refs WHERE id=?").get(id);
    if (!reference || reference.workspace_id !== workspace.id) throw new Error("workspace_reference_out_of_scope");
    const { record } = attachments.importWorkspaceReference(workspace, reference.relative_path);
    if (reference.snapshot_hash && reference.snapshot_hash !== record.sha256) throw new Error("workspace_ref_stale");
    parts.push({ type: "workspace_ref", refId: id, relativePath: reference.relative_path, snapshotHash: record.sha256, attachmentId: record.id });
    blocks.push(JSON.stringify({ path: reference.relative_path, sha256: record.sha256, content: textOf(record.id).text }));
  }
  for (const id of [...new Set(attachmentIds)]) {
    if (!attachments.belongsToWorkspace(id, workspace.id)) throw new Error("attachment_out_of_scope");
    const { record, text } = textOf(id);
    parts.push({ type: "file", attachmentId: id, mediaType: record.mediaType, filename: record.filename });
    blocks.push(JSON.stringify({ filename: record.filename, sha256: record.sha256, content: text }));
  }
  return { parts, text: blocks.join("\n\n") };
}
