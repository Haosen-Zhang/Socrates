import { useEffect, useRef } from "react";
import { clampPanelSize, keyboardPanelSize, type ResizeEdge } from "./panelResize";

export default function PanelResizeHandle({ edge, size, min, max, label, onResize, onCommit }: {
  edge: ResizeEdge;
  size: number;
  min: number;
  max: number;
  label: string;
  onResize: (size: number) => void;
  onCommit: (size: number) => void;
}) {
  const drag = useRef<{ startX: number; startSize: number; latest: number } | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    drag.current = null;
    document.body.classList.remove("is-resizing-panel");
  }, []);
  const finish = () => {
    if (!drag.current) return;
    const latest = drag.current.latest;
    drag.current = null;
    document.body.classList.remove("is-resizing-panel");
    onCommit(latest);
  };

  return <div
    className={`panel-resize-handle panel-resize-handle--${edge}`}
    role="separator"
    tabIndex={0}
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={min}
    aria-valuemax={max}
    aria-valuenow={size}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { startX: event.clientX, startSize: size, latest: size };
      document.body.classList.add("is-resizing-panel");
    }}
    onPointerMove={(event) => {
      if (!drag.current) return;
      const direction = edge === "end" ? 1 : -1;
      const next = clampPanelSize(drag.current.startSize + (event.clientX - drag.current.startX) * direction, min, max);
      drag.current.latest = next;
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => { frame.current = null; if (drag.current) onResize(drag.current.latest); });
    }}
    onPointerUp={finish}
    onPointerCancel={finish}
    onLostPointerCapture={finish}
    onKeyDown={(event) => {
      const next = keyboardPanelSize(size, event.key, edge, min, max);
      if (next == null) return;
      event.preventDefault();
      onResize(next);
      onCommit(next);
    }}
  />;
}
