import PixelIcon from "../PixelIcon";
import { useT } from "../store";
import type { WorkspaceDockMode } from "./workspaceDockState";

export default function WorkspaceDockButtons({ mode, disabled, onSelect }: {
  mode: WorkspaceDockMode;
  disabled: boolean;
  onSelect: (mode: "files" | "diff") => void;
}) {
  const t = useT();
  if (disabled) return null;
  return <div className="flex items-center gap-1" role="group" aria-label={t("workspace_tools")}>
    <button type="button" className={`pixel-button pixel-dock-trigger ${mode === "files" ? "pixel-button--primary" : ""}`} disabled={disabled} aria-pressed={mode === "files"} title={t("workspace_browse_files")} onClick={() => onSelect("files")}>
      <PixelIcon name="folder" size={16} /><span>{t("workspace_files")}</span>
    </button>
    <button type="button" className={`pixel-button pixel-dock-trigger ${mode === "diff" ? "pixel-button--primary" : ""}`} disabled={disabled} aria-pressed={mode === "diff"} title={t("workspace_view_diff")} onClick={() => onSelect("diff")}>
      <PixelIcon name="diff" size={16} /><span>{t("workspace_changes")}</span>
    </button>
  </div>;
}
