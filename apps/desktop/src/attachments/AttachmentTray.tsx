import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useCallback, useEffect, useState } from "react";
import { useStore, useT } from "../store";
import PixelIcon from "../PixelIcon";

export function AttachmentImage({ id, alt, className = "h-12 w-12" }: { id: string; alt: string; className?: string }) {
  const handshake = useStore((state) => state.handshake);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!handshake) return;
    let active = true;
    let objectUrl: string | null = null;
    void fetch(`http://127.0.0.1:${handshake.port}/content/attachments/${id}`, { headers: { Authorization: `Bearer ${handshake.token}` } })
      .then((response) => response.ok ? response.blob() : Promise.reject(new Error("preview_failed")))
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setUrl(objectUrl);
      }).catch(() => {});
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [handshake, id]);
  return url ? <img src={url} alt={alt} className={`${className} object-cover [image-rendering:auto]`} /> : <span className={`${className} animate-pulse bg-neutral-200`} />;
}

export default function AttachmentTray() {
  const { activeWorkspace, workspaces, sessions, currentSessionId, draftAttachments, draftWorkspaceRefs, importWorkspaceAttachment, importClipboardAttachment, removeDraftAttachment, removeDraftWorkspaceRef } = useStore();
  const boundId = sessions.find((session) => session.id === currentSessionId)?.workspaceId;
  const workspace = (boundId ? workspaces.find((item) => item.id === boundId) : null) ?? activeWorkspace;
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const addPaths = useCallback(async (paths: string[]) => {
    setError(null);
    for (const path of paths.slice(0, 10)) {
      try { await importWorkspaceAttachment(path); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    }
  }, [importWorkspaceAttachment]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") void addPaths(event.payload.paths);
    }).then((dispose) => { unlisten = dispose; }).catch(() => {});
    return () => unlisten?.();
  }, [addPaths]);

  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].slice(0, 10);
      if (!files.length) return;
      event.preventDefault();
      setError(null);
      void (async () => {
        for (const file of files) {
          try { await importClipboardAttachment(file); }
          catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        }
      })();
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [importClipboardAttachment]);

  const choose = async () => {
    const selected = await open({ multiple: true, directory: false });
    if (selected) await addPaths(Array.isArray(selected) ? selected : [selected]);
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" className="pixel-button flex items-center gap-1 px-2 py-1 text-xs" disabled={!workspace} onClick={() => void choose()}>
          <PixelIcon name="plus" size={14} /> {t("attach_file")}
        </button>
        {draftWorkspaceRefs.map((reference) => (
          <button key={reference.id} type="button" className="pixel-chip" onClick={() => removeDraftWorkspaceRef(reference.id)}>@{reference.relativePath} ×</button>
        ))}
        {draftAttachments.map((attachment) => (
          <div key={attachment.id} className="pixel-attachment-chip flex items-center gap-2 p-1.5 text-xs">
            {attachment.mediaType.startsWith("image/") && <AttachmentImage id={attachment.id} alt={attachment.filename} />}
            <span className="max-w-40 truncate">{attachment.filename}</span>
            <button type="button" aria-label={`Remove ${attachment.filename}`} onClick={() => removeDraftAttachment(attachment.id)}>×</button>
          </div>
        ))}
      </div>
      {error && <div role="alert" className="mb-2 text-xs text-red-700">{error}</div>}
    </div>
  );
}
