import PixelIcon from "../PixelIcon";
import { useT } from "../store";
import type { WorkspaceDockMode } from "./workspaceDockState";

export default function WorkspaceDockButtons({ mode, disabled, onSelect }: {
  mode: WorkspaceDockMode;
  disabled?: boolean;
  onSelect: (mode: "overview") => void;
}) {
  const t = useT();
  return <button type="button" className={`pixel-button pixel-dock-trigger ${mode !== "closed" ? "pixel-button--primary" : ""}`} disabled={disabled} aria-pressed={mode !== "closed"} aria-label={t("workspace_overview")} title={t("workspace_overview")} onClick={() => onSelect("overview")}>
    <PixelIcon name="sidebar" size={16} /><span className="sr-only">workspace_overview</span>
  </button>;
}
