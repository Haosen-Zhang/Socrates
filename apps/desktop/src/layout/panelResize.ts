export type ResizeEdge = "start" | "end";

export function clampPanelSize(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.round(value), min), Math.max(min, max));
}

export function keyboardPanelSize(
  size: number,
  key: string,
  edge: ResizeEdge,
  min: number,
  max: number,
  step = 16,
): number | null {
  if (key === "Home") return min;
  if (key === "End") return max;
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const direction = key === "ArrowRight" ? 1 : -1;
  return clampPanelSize(size + direction * (edge === "end" ? step : -step), min, max);
}
