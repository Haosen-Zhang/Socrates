export const IME_CONFIRM_GRACE_MS = 100;

export type ComposerEnterEvent = {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

export type ComposerCompositionState = {
  composing: boolean;
  lastCompositionEndAt: number;
  now?: number;
};

/**
 * WebKit can report isComposing=false for the Enter that confirms an IME
 * candidate. Track all available signals and briefly guard compositionend.
 */
export function shouldSubmitComposerEnter(
  event: ComposerEnterEvent,
  state: ComposerCompositionState,
): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  const now = state.now ?? Date.now();
  return !(
    state.composing ||
    event.isComposing === true ||
    event.keyCode === 229 ||
    now - state.lastCompositionEndAt < IME_CONFIRM_GRACE_MS
  );
}
