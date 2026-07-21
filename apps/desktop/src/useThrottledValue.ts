import { useEffect, useRef, useState } from "react";

/**
 * 节流决策（纯函数，可测）：距上次发射已够久则立即发射，否则安排在窗口尾部发射。
 * 尾部安排保证「最终值一定到达」——流式结束时不丢字。
 */
export function throttleDecision(
  lastEmitMs: number,
  nowMs: number,
  intervalMs: number,
): { emit: boolean; delay: number } {
  const elapsed = nowMs - lastEmitMs;
  if (elapsed >= intervalMs) return { emit: true, delay: 0 };
  return { emit: false, delay: intervalMs - elapsed };
}

/**
 * 节流值（P0.4）：高频变化的输入按固定间隔向下游传递，但保证最终值一定到达。
 * 用于流式 Markdown 源——避免每个 rAF flush 都重跑 react-markdown 全量解析。
 */
export function useThrottledValue<T>(value: T, intervalMs = 250): T {
  const [throttled, setThrottled] = useState(value);
  const lastEmit = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;

  useEffect(() => {
    const { emit, delay } = throttleDecision(lastEmit.current, Date.now(), intervalMs);
    if (emit) {
      lastEmit.current = Date.now();
      setThrottled(value);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastEmit.current = Date.now();
      setThrottled(latest.current);
    }, delay);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, intervalMs]);

  return throttled;
}
