export type ContextWindowUsage = {
  inputTokens: number;
  capacity: number;
  ratio: number;
  percent: number;
  overCapacity: boolean;
};

export function contextWindowUsage(inputTokens: number | null | undefined, capacity: number | null | undefined): ContextWindowUsage | null {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(capacity) || inputTokens == null || capacity == null || inputTokens < 0 || capacity <= 0) return null;
  const ratio = inputTokens / capacity;
  return { inputTokens, capacity, ratio, percent: Math.round(ratio * 100), overCapacity: ratio > 1 };
}
