/**
 * 分段控件的键盘导航（C3，纯函数）。
 * 真正的 segmented control：左右方向键在选项间移动，Home/End 跳到两端，
 * Enter/Space 由浏览器的 button 语义处理，不需要额外逻辑。
 */
export type SegmentKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export function nextSegment<T extends string>(options: readonly T[], current: T, key: string): T {
  const index = options.indexOf(current);
  if (index < 0 || options.length === 0) return current;
  switch (key) {
    case "ArrowLeft":
      return options[(index - 1 + options.length) % options.length];
    case "ArrowRight":
      return options[(index + 1) % options.length];
    case "Home":
      return options[0];
    case "End":
      return options[options.length - 1];
    default:
      return current;
  }
}

export function isSegmentKey(key: string): key is SegmentKey {
  return key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End";
}
