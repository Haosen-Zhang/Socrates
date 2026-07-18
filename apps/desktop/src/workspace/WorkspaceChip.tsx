import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { useStore, useT } from "../store";
import PixelIcon from "../PixelIcon";

export default function WorkspaceChip({ workspaceId, locked = false }: { workspaceId?: string | null; locked?: boolean }) {
  const { activeWorkspace, workspaces, selectWorkspacePath, setActiveWorkspace, activeTaskId, agentRunning } = useStore();
  const workspace = workspaceId ? workspaces.find((item) => item.id === workspaceId) ?? null : activeWorkspace;
  const [error, setError] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const t = useT();

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenMenu(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, []);

  const choose = async () => {
    if (activeTaskId || agentRunning || locked) return;
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false, title: t("workspace_choose") });
      if (typeof selected === "string") await selectWorkspacePath(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const chooseKnownWorkspace = async (id: string | null) => {
    setError(null);
    try {
      await setActiveWorkspace(id);
      setOpenMenu(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        className="pixel-workspace-chip flex max-w-56 items-center gap-1.5 px-2 py-1 text-xs"
        onClick={() => {
          if (!locked && !activeTaskId && !agentRunning) setOpenMenu((value) => !value);
        }}
        disabled={Boolean(activeTaskId) || agentRunning || locked}
        title={workspace?.canonicalPath ?? t("project_none")}
      >
        <PixelIcon name="folder" size={18} />
        <span className="truncate">{locked ? workspace?.label ?? t("workspace_none") : t("project_picker")}</span>
        {!locked && workspace && <span className="pixel-project-status" aria-label={t("project_current")} />}
      </button>
      {openMenu && (
        <div className="pixel-project-menu anim-panel absolute left-0 top-full z-30 mt-2 w-72 p-2" role="menu" aria-label={t("project_picker")}>
          <button className={`pixel-project-menu-item ${!activeWorkspace ? "is-active" : ""}`} role="menuitem" onClick={() => void chooseKnownWorkspace(null)}>
            <PixelIcon name="chat" size={16} />
            <span className="min-w-0 flex-1 text-left">{t("project_none")}</span>
          </button>
          {workspaces.filter((item) => !item.archived).map((item) => (
            <button key={item.id} className={`pixel-project-menu-item ${activeWorkspace?.id === item.id ? "is-active" : ""}`} role="menuitem" title={item.canonicalPath} onClick={() => void chooseKnownWorkspace(item.id)}>
              <PixelIcon name="folder" size={16} />
              <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
              {activeWorkspace?.id === item.id && <span aria-hidden>✓</span>}
            </button>
          ))}
          <div className="my-2 border-t border-neutral-200" />
          <button className="pixel-project-menu-item pixel-project-menu-item--open" role="menuitem" onClick={() => void choose()}>
            <PixelIcon name="plus" size={16} />
            <span>{t("project_open_folder")}</span>
          </button>
        </div>
      )}
      {error && <div role="alert" className="absolute right-0 top-full z-20 mt-1 w-72 border border-red-500 bg-white p-2 text-xs text-red-700">{error}</div>}
    </div>
  );
}
