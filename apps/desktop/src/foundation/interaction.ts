import { IME_CONFIRM_GRACE_MS } from "../composerIme";

export type ImeState = {
  composing: boolean;
  lastCompositionEndAt: number;
};

export function isImeInteraction(
  event: { isComposing?: boolean; keyCode?: number },
  state: ImeState,
  now = Date.now(),
): boolean {
  return state.composing || event.isComposing === true || event.keyCode === 229 ||
    now - state.lastCompositionEndAt < IME_CONFIRM_GRACE_MS;
}
