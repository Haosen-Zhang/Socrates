import { useEffect, useRef, useState } from "react";
import { useStorePick } from "../selectors";
import { useT } from "../store";
import { sfx } from "../fx";
import { isOwnedManagedWorkspace } from "../roomSelection";
import { resolveSidebarRevealPath, revealResolvedSidebarTarget } from "./revealInFinder";
import { useAnimatedDialogClose } from "../dialog/useAnimatedDialogClose";

/** Side-bar entities all share the same predictable rename/archive/remove menu. */
type SidebarEntityKind = "room" | "session" | "workspace";
/** 侧栏统一行：rooms 与 sessions 折算成同一形状，source 决定打开哪条路径 */
export type MenuState = { kind: SidebarEntityKind; id: string; x: number; y: number };
export type RenameTarget = { kind: SidebarEntityKind; id: string; value: string };

export function SidebarEntityMenu({
  menu,
  onClose,
  onRename,
  onCollab,
  onError,
}: {
  menu: MenuState;
  onClose: () => void;
  onRename: (target: RenameTarget) => void;
  onCollab: (sessionId: string) => void;
  onError: (message: string) => void;
}) {
  const {
    rooms, sessions, workspaces,
    archiveRoom, removeRoom, archiveSession, removeSession, archiveWorkspace, removeWorkspace,
  } = useStorePick("rooms", "sessions", "workspaces", "archiveRoom", "removeRoom", "archiveSession", "removeSession", "archiveWorkspace", "removeWorkspace");
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const entity = menu.kind === "room"
    ? rooms.find((room) => room.id === menu.id)
    : menu.kind === "session"
      ? sessions.find((session) => session.id === menu.id)
      : workspaces.find((workspace) => workspace.id === menu.id);

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // The trigger is a click. Closing on window click made a newly mounted menu
    // consume that very same event and disappear before it could be seen.
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  if (!entity) return null;
  const value = "name" in entity ? entity.name : "title" in entity ? entity.title : entity.label;
  const archived = entity.archived;
  const managedSessionWorkspace = menu.kind === "session" && "workspaceId" in entity
    ? workspaces.find((workspace) => (
      workspace.id === entity.workspaceId && isOwnedManagedWorkspace(workspace, entity.id)
    ))
    : null;
  const revealTarget = resolveSidebarRevealPath(menu, sessions, workspaces);
  const item = "block w-full px-3 py-2 text-left text-sm hover:bg-neutral-100";
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
      onClose();
    } catch (error) {
      onError(error instanceof Error && error.message === "workspace_not_found"
        ? t("reveal_workspace_missing")
        : error instanceof Error ? error.message : String(error));
      onClose();
    }
  };
  return (
    <div
      ref={menuRef}
      className="pixel-card anim-panel fixed z-[90] w-48 overflow-hidden py-1"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className={item}
        onClick={() => {
          onRename({ kind: menu.kind, id: menu.id, value });
          onClose();
        }}
      >
        {t("rename")}
      </button>
      {revealTarget && (
        <button
          className={item}
          onClick={() => void run(() => revealResolvedSidebarTarget(revealTarget))}
        >
          {t("reveal_in_finder")}
        </button>
      )}
      {menu.kind === "session" && "kind" in entity && entity.kind === "cowork" && (
        <button
          className={item}
          onClick={() => {
            onCollab(menu.id);
            onClose();
          }}
        >
          {t("cowork_settings_title")}
        </button>
      )}
      <button
        className={item}
        onClick={() => {
          sfx.delete();
          void run(() => menu.kind === "room"
            ? archiveRoom(menu.id, !archived)
            : menu.kind === "session"
              ? archiveSession(menu.id, !archived)
              : archiveWorkspace(menu.id, !archived));
        }}
      >
        {archived ? t("unarchive") : t("archive")}
      </button>
      {confirming && managedSessionWorkspace ? (
        <>
          <div className="px-3 py-2 text-xs text-neutral-600">{t("managed_workspace_delete_prompt")}</div>
          <button className={`${item} text-red-700`} onClick={() => {
            sfx.delete();
            void run(() => removeSession(menu.id, "keep"));
          }}>{t("delete_room_keep_files")}</button>
          <button className={`${item} font-medium text-red-700`} onClick={() => {
            sfx.delete();
            void run(() => removeSession(menu.id, "delete"));
          }}>{t("delete_room_and_files")}</button>
        </>
      ) : (
        <button
          className={`${item} ${confirming ? "font-medium text-red-700" : "text-red-600"}`}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            sfx.delete();
            void run(() => menu.kind === "room"
              ? removeRoom(menu.id)
              : menu.kind === "session"
                ? removeSession(menu.id)
                : removeWorkspace(menu.id));
          }}
        >
          {confirming ? t("confirm_delete") : menu.kind === "workspace" ? t("remove_from_socrates") : t("delete")}
        </button>
      )}
    </div>
  );
}

export function RenameDialog({ target, onClose }: { target: RenameTarget; onClose: () => void }) {
  const { renameRoom, renameSession, renameWorkspace } = useStorePick("renameRoom", "renameSession", "renameWorkspace");
  const t = useT();
  const dialog = useAnimatedDialogClose(onClose);
  const [value, setValue] = useState(target.value);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const next = value.trim();
      if (!next) throw new Error("name_required");
      if (target.kind === "room") await renameRoom(target.id, next);
      else if (target.kind === "session") await renameSession(target.id, next);
      else await renameWorkspace(target.id, next);
      dialog.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className={`pixel-dialog-backdrop ${dialog.closing ? "is-closing" : ""}`} role="presentation" onMouseDown={dialog.close}>
      <form className="pixel-dialog w-[min(440px,calc(100vw-40px))] p-5" role="dialog" aria-modal="true" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div><div className="pixel-kicker">RENAME</div><h2 className="text-lg font-bold">{t(`rename_${target.kind}`)}</h2></div>
          <button className="pixel-button h-8 w-8" type="button" aria-label={t("close")} onClick={dialog.close}>×</button>
        </div>
        <input autoFocus className="pixel-input w-full px-3 py-2 text-sm" value={value} maxLength={80} onChange={(event) => { setValue(event.target.value); setError(null); }} />
        {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button className="pixel-button px-3 py-2 text-sm" type="button" onClick={dialog.close}>{t("cancel")}</button><button className="pixel-button pixel-button--primary px-4 py-2 text-sm" disabled={!value.trim()}>{t("save")}</button></div>
      </form>
    </div>
  );
}
