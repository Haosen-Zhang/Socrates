import { useRef } from "react";
import type { AppMode } from "@socrates/core";
import { isSegmentKey, nextSegment } from "./segmented";

const OPTIONS = ["chat", "cowork"] as const;

/**
 * Chat / Co-work 分段控件（C3）。
 *
 * 是真正的 tablist（不是两个各自独立的按钮）：roving tabindex + 左右/Home/End
 * 方向键切换，Tab 只进出整个控件。滑块用 transform 位移，不改 width/left，
 * 避免布局抖动；模式切换本身不触碰任何房间的持久化类型或绑定。
 */
export default function ModeSegmented({
  mode,
  onChange,
  labels,
  collapsed = false,
}: {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  labels: Record<AppMode, string>;
  collapsed?: boolean;
}) {
  const refs = useRef<Partial<Record<AppMode, HTMLButtonElement | null>>>({});

  const handleKey = (event: React.KeyboardEvent) => {
    if (!isSegmentKey(event.key)) return;
    event.preventDefault();
    const target = nextSegment(OPTIONS, mode, event.key);
    if (target !== mode) onChange(target);
    refs.current[target]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={`${labels.chat} / ${labels.cowork}`}
      aria-orientation="horizontal"
      className={`pixel-segmented ${collapsed ? "pixel-segmented--collapsed" : ""}`}
      onKeyDown={handleKey}
    >
      <span className="pixel-segmented__thumb" data-active={mode} aria-hidden />
      {OPTIONS.map((option) => (
        <button
          key={option}
          ref={(node) => {
            refs.current[option] = node;
          }}
          role="tab"
          type="button"
          aria-selected={mode === option}
          // roving tabindex：整个控件只占一个 Tab 停留点
          tabIndex={mode === option ? 0 : -1}
          title={labels[option]}
          className="pixel-segmented__option"
          onClick={() => onChange(option)}
        >
          {collapsed ? labels[option].slice(0, 1) : labels[option]}
        </button>
      ))}
    </div>
  );
}
