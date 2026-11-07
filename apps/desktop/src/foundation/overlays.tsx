import { useId, useLayoutEffect, useRef, type ReactElement, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import PanelResizeHandle from "../layout/PanelResizeHandle";
import { ErrorNotice } from "./components";
import { portalContainer, useImeGuard, useNarrowViewport, usePortalHost } from "./useFoundation";

export type DetailPanelProps = {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  drawer?: boolean;
  description?: string;
  closeLabel?: string;
  resize?: {
    size: number;
    min: number;
    max: number;
    label: string;
    onResize: (size: number) => void;
    onCommit: (size: number) => void;
  };
};

export function DetailPanel({ title, open, onClose, children, drawer, description, closeLabel, resize }: DetailPanelProps) {
  const titleId = useId();
  const narrow = useNarrowViewport();
  const ime = useImeGuard();
  if (!(drawer ?? narrow)) {
    if (!open) return null;
    return (
      <aside className="foundation-detail-panel" aria-labelledby={titleId} style={resize ? { width: resize.size, flex: "none" } : undefined}>
        {resize && <PanelResizeHandle edge="start" {...resize} />}
        <header className="foundation-detail-panel__header">
          <div><h2 id={titleId}>{title}</h2>{description && <p>{description}</p>}</div>
          <button type="button" className="pixel-button foundation-close" onClick={onClose} aria-label={closeLabel ?? title}>×</button>
        </header>
        <div className="foundation-detail-panel__content">{children}</div>
      </aside>
    );
  }
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && details.reason === "escape-key" && ime.isComposing(details.event)) {
          details.cancel();
          return;
        }
        if (!nextOpen) onClose();
      }}
    >
      <Dialog.Portal container={portalContainer()} data-dialog-layer="nested" onMouseDown={(event) => event.stopPropagation()}>
        <Dialog.Backdrop className="foundation-dialog-backdrop" />
        <Dialog.Popup
          className="pixel-dialog foundation-drawer"
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDownCapture={ime.onKeyDownCapture}
        >
          <header className="foundation-detail-panel__header">
            <div><Dialog.Title>{title}</Dialog.Title><Dialog.Description className={description ? undefined : "foundation-sr-only"}>{description ?? title}</Dialog.Description></div>
            <Dialog.Close className="pixel-button foundation-close" aria-label={closeLabel ?? title}>×</Dialog.Close>
          </header>
          <div className="foundation-detail-panel__content">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export type ConfirmationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void | Promise<void>;
  pending?: boolean;
  error?: string | null;
  children?: ReactNode;
};

export function ConfirmationDialog({ open, onOpenChange, title, description, confirmLabel, cancelLabel, onConfirm, pending = false, error, children }: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<{ trigger: HTMLElement | null; parent: HTMLElement | null }>({ trigger: null, parent: null });
  const ime = useImeGuard();
  useLayoutEffect(() => {
    if (!open || typeof document === "undefined") return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnFocus.current = { trigger, parent: trigger?.closest<HTMLElement>('[role="dialog"]') ?? null };
  }, [open]);
  return (
    <Dialog.Root
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && (pending || (details.reason === "escape-key" && ime.isComposing(details.event)))) {
          details.cancel();
          return;
        }
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal container={portalContainer()} data-dialog-layer="nested" onMouseDown={(event) => event.stopPropagation()}>
        <Dialog.Backdrop className="foundation-dialog-backdrop" />
        <Dialog.Popup
          className="pixel-dialog foundation-confirmation-dialog"
          initialFocus={cancelRef}
          finalFocus={() => returnFocus.current.trigger?.isConnected ? returnFocus.current.trigger : returnFocus.current.parent?.isConnected ? returnFocus.current.parent : true}
          aria-busy={pending}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDownCapture={ime.onKeyDownCapture}
        >
          <Dialog.Title className="foundation-confirmation-dialog__title">{title}</Dialog.Title>
          <Dialog.Description className="foundation-confirmation-dialog__description">{description}</Dialog.Description>
          {children}
          {error && <ErrorNotice message={error} />}
          <footer className="foundation-confirmation-dialog__actions">
            <Dialog.Close ref={cancelRef} className="pixel-button foundation-button" disabled={pending}>{cancelLabel}</Dialog.Close>
            <button type="button" className="pixel-button pixel-button--primary foundation-button" disabled={pending} onClick={() => { if (!pending) void onConfirm(); }}>{confirmLabel}</button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Tooltip({ label, children }: { label: string; children: ReactElement }) {
  const { container, anchorRef } = usePortalHost();
  return (
    <BaseTooltip.Provider delay={450}>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger ref={anchorRef} render={children} />
        <BaseTooltip.Portal container={container}>
          <BaseTooltip.Positioner sideOffset={7} className="foundation-tooltip-positioner">
            <BaseTooltip.Popup className="foundation-tooltip">{label}</BaseTooltip.Popup>
          </BaseTooltip.Positioner>
        </BaseTooltip.Portal>
      </BaseTooltip.Root>
    </BaseTooltip.Provider>
  );
}
