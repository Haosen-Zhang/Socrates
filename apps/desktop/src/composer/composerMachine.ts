export const COMPOSER_MIN_HEIGHT = 104;
export const COMPOSER_DEFAULT_HEIGHT = 104;

export function composerMaxHeight(viewportHeight: number): number {
  return Math.max(COMPOSER_MIN_HEIGHT, Math.min(360, Math.floor(viewportHeight * 0.4)));
}

export function clampComposerHeight(height: number, viewportHeight: number): number {
  return Math.min(composerMaxHeight(viewportHeight), Math.max(COMPOSER_MIN_HEIGHT, Math.round(height)));
}

export function composerHeightFromPointer(input: { startHeight: number; startY: number; currentY: number; viewportHeight: number }): number {
  return clampComposerHeight(input.startHeight + input.startY - input.currentY, input.viewportHeight);
}

export function composerHeightFromKey(height: number, key: "ArrowUp" | "ArrowDown", largeStep: boolean, viewportHeight: number): number {
  const direction = key === "ArrowUp" ? 1 : -1;
  return clampComposerHeight(height + direction * (largeStep ? 24 : 8), viewportHeight);
}
