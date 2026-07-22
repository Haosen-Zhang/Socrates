/**
 * 长列表窗口化（P0/R5）：只渲染最近 N 条，更早的折叠为「显示更早」入口。
 * 纯函数——不改变数据、不丢消息，仅决定当前渲染切片，可测。
 *
 * 选窗口化而非虚拟化的理由：聊天时间线含变高元素（Markdown/代码块/审批卡），
 * 虚拟化需要精确测高才不破坏滚动与读屏；窗口化用零依赖实现同样给出 DOM 上界，
 * 且展开后行为与原先完全一致。
 */
export const DEFAULT_WINDOW_SIZE = 80;
export const WINDOW_STEP = 80;

export type ListWindow<T> = {
  /** 当前应渲染的切片（保持原顺序） */
  visible: T[];
  /** 被折叠在前面的条数；0 表示无折叠 */
  hiddenCount: number;
};

export function windowTail<T>(items: readonly T[], limit: number): ListWindow<T> {
  if (limit <= 0 || items.length <= limit) return { visible: [...items], hiddenCount: 0 };
  return { visible: items.slice(items.length - limit), hiddenCount: items.length - limit };
}

/** 点击「显示更早」后的新上限（不超过总数） */
export function expandWindow(currentLimit: number, total: number, step = WINDOW_STEP): number {
  return Math.min(total, currentLimit + step);
}
