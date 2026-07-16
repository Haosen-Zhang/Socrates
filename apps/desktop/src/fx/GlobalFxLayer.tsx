import { useEffect } from "react";
import { pixelBurstAt } from "../fx";

export type ParticleClick = Pick<MouseEvent, "detail" | "button" | "clientX" | "clientY">;

export function particlePointForClick(event: ParticleClick): { x: number; y: number } | null {
  if (event.detail <= 0 || event.button !== 0) return null;
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
  return { x: event.clientX, y: event.clientY };
}

export default function GlobalFxLayer() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const point = particlePointForClick(event);
      if (point) pixelBurstAt(point.x, point.y);
    };
    document.addEventListener("click", onClick, { capture: true, passive: true });
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
