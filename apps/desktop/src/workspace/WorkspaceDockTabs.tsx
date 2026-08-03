import PixelIcon from "../PixelIcon";
import { useT } from "../store";
import type { WorkspaceDockMode } from "./workspaceDockState";

const TABS = [
  { mode: "overview", icon: "general", label: "workspace_overview" },
  { mode: "files", icon: "file", label: "workspace_files" },
  { mode: "diff", icon: "diff", label: "workspace_changes" },
] as const;

export default function WorkspaceDockTabs({ mode, hasWorkspace, onSelect }: {
  mode: Exclude<WorkspaceDockMode, "closed">;
  hasWorkspace: boolean;
  onSelect: (mode: Exclude<WorkspaceDockMode, "closed">) => void;
}) {
  const t = useT();
  return <div className="pixel-workspace-dock__tabs" role="tablist" aria-label={t("workspace_tools")}>
    {TABS.map((tab) => {
      const selected = tab.mode === mode;
      const disabled = tab.mode !== "overview" && !hasWorkspace;
      return <button
        key={tab.mode}
        type="button"
        role="tab"
        aria-selected={selected}
        disabled={disabled}
        title={disabled ? t("workspace_required_for_tools") : t(tab.label)}
        onClick={() => onSelect(tab.mode)}
      >
        <PixelIcon name={tab.icon} size={16} />
        <span className="truncate">{t(tab.label)}</span>
      </button>;
    })}
  </div>;
}
