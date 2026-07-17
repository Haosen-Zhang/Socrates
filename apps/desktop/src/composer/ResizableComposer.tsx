import { useEffect, useRef, useState, type ReactNode } from "react";
import { clampComposerHeight, COMPOSER_DEFAULT_HEIGHT, composerHeightFromKey, composerHeightFromPointer, composerMaxHeight } from "./composerMachine";

const STORAGE_KEY = "socrates.composer.height.v1";

function initialHeight(): number {
  const saved = Number(localStorage.getItem(STORAGE_KEY));
  return clampComposerHeight(Number.isFinite(saved) ? saved : COMPOSER_DEFAULT_HEIGHT, window.innerHeight);
}

export default function ResizableComposer({ children, configured = false, label }: { children: ReactNode; configured?: boolean; label: string }) {
  const [height, setHeight] = useState(initialHeight);
  const frame = useRef<number | null>(null);
  const drag = useRef<{ startHeight: number; startY: number } | null>(null);
  const apply = (next: number) => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      setHeight(clampComposerHeight(next, window.innerHeight));
      frame.current = null;
    });
  };
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(height));
  }, [height]);
  useEffect(() => {
    const resize = () => apply(height);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [height]);
  return <div className={`pixel-composer relative flex items-end gap-2 px-3 py-2 ${configured ? "pixel-composer--configured" : ""}`} style={{ height }}>
    <div
      className="pixel-composer-resize-handle"
      role="separator"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuemin={104}
      aria-valuemax={composerMaxHeight(window.innerHeight)}
      aria-valuenow={height}
      tabIndex={0}
      onDoubleClick={() => apply(COMPOSER_DEFAULT_HEIGHT)}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        apply(composerHeightFromKey(height, event.key, event.shiftKey, window.innerHeight));
      }}
      onPointerDown={(event) => {
        drag.current = { startHeight: height, startY: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        apply(composerHeightFromPointer({ ...drag.current, currentY: event.clientY, viewportHeight: window.innerHeight }));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }}
    />
    {children}
  </div>;
}
