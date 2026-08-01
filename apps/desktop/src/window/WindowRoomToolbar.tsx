import type { ReactNode } from "react";
import PixelIcon from "../PixelIcon";
import type { WindowToolbarMode } from "./windowChrome";

export default function WindowRoomToolbar({
  title,
  subtitle,
  sidebarHidden,
  toolbarMode,
  collapseLabel,
  expandLabel,
  onToggleSidebar,
  children,
}: {
  title: string;
  subtitle?: string;
  sidebarHidden: boolean;
  toolbarMode: WindowToolbarMode;
  collapseLabel: string;
  expandLabel: string;
  onToggleSidebar: () => void;
  children?: ReactNode;
}) {
  const toggleLabel = sidebarHidden ? expandLabel : collapseLabel;
  return (
    <header
      className="pixel-window-toolbar"
      data-window-mode={toolbarMode}
      data-sidebar-hidden={sidebarHidden}
      data-tauri-drag-region
    >
      <div className="pixel-window-toolbar__identity" data-tauri-drag-region>
        <button
          type="button"
          className="pixel-window-toolbar__sidebar-toggle"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-expanded={!sidebarHidden}
          onClick={onToggleSidebar}
        >
          <PixelIcon name="sidebar" size={16} />
        </button>
        <div className="min-w-0" data-tauri-drag-region>
          <div className="truncate text-sm font-bold" data-tauri-drag-region>{title}</div>
          {subtitle && <div className="truncate text-[9px] uppercase tracking-wider text-neutral-500" data-tauri-drag-region>{subtitle}</div>}
        </div>
      </div>
      {children && <div className="pixel-window-toolbar__actions">{children}</div>}
    </header>
  );
}
