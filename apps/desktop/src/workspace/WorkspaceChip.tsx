import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useStore, useT } from "../store";
import PixelIcon from "../PixelIcon";

export default function WorkspaceChip() {
  const { activeWorkspace, selectWorkspacePath, activeTaskId } = useStore();
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const choose = async () => {
    if (activeTaskId) return;
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false, title: t("workspace_choose") });
      if (typeof selected === "string") await selectWorkspacePath(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="relative">
      <button
        className="pixel-workspace-chip flex max-w-56 items-center gap-1.5 px-2 py-1 text-xs"
        onClick={() => void choose()}
        disabled={Boolean(activeTaskId)}
        title={activeWorkspace?.canonicalPath ?? t("workspace_choose")}
      >
        <PixelIcon name="folder" size={18} />
        <span className="truncate">{activeWorkspace?.label ?? t("workspace_none")}</span>
      </button>
      {error && <div role="alert" className="absolute right-0 top-full z-20 mt-1 w-72 border border-red-500 bg-white p-2 text-xs text-red-700">{error}</div>}
    </div>
  );
}
