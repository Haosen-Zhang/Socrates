import { useEffect, useRef } from "react";
import { useT } from "../store";
import Settings from "../Settings";
import { sfx } from "../fx";
import { hasOpenNestedDialog } from "../dialog/dialogLayer";

/**
 * Settings 以模态面板呈现（C6）。
 *
 * 它是 overlay：底下的房间导航状态原样保留，关闭后焦点回到触发它的元素。
 * 单实例由 settingsOverlay 状态机保证——这里只负责在 focusNonce 变化时重新聚焦。
 */
export default function SettingsOverlayHost({
  open,
  focusNonce,
  onClose,
}: {
  open: boolean;
  focusNonce: number;
  onClose: () => void;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  // 打开时记住触发元素，关闭后把焦点还回去
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    return () => restoreFocusTo.current?.focus?.();
  }, [open]);

  // 每次「打开」请求（含重复触发）都把焦点移进面板，而不是新建实例
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open, focusNonce]);

  // Escape 关闭 + 焦点陷阱：Tab 在面板内循环
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasOpenNestedDialog(document)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="pixel-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings_title")}
        className="pixel-dialog flex h-[min(760px,calc(100vh-64px))] w-[min(1040px,calc(100vw-64px))] flex-col overflow-hidden outline-none"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b-2 border-[var(--pixel-ink)] px-5 py-3">
          <div>
            <div className="pixel-kicker">PREFERENCES</div>
            <h2 className="text-lg font-bold">{t("settings_title")}</h2>
          </div>
          <button
            className="pixel-button h-8 w-8"
            aria-label={t("close")}
            onClick={() => {
              sfx.close();
              onClose();
            }}
          >
            ×
          </button>
        </header>
        {/* 独立滚动区：设置内容不影响底下房间的滚动位置 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Settings />
        </div>
      </div>
    </div>
  );
}
