import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 自动复位的瞬时标志（P0/R6）：用于「已复制」「确认删除？」这类短暂 UI 状态。
 * 组件卸载时清理定时器，避免对已卸载组件 setState。
 */
export function useTransientFlag(resetAfterMs: number): [boolean, () => void, () => void] {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const trigger = useCallback(() => {
    clear();
    setActive(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setActive(false);
    }, resetAfterMs);
  }, [clear, resetAfterMs]);

  const reset = useCallback(() => {
    clear();
    setActive(false);
  }, [clear]);

  useEffect(() => clear, [clear]); // 卸载时清理
  return [active, trigger, reset];
}
