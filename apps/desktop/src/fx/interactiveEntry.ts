export const INTERACTIVE_SELECTOR = "button, [role='button'], a[href]";

type InteractiveLike = Element & {
  disabled?: boolean;
  hidden?: boolean;
  inert?: boolean;
};

export function getInteractiveRoot(target: EventTarget | null): InteractiveLike | null {
  const candidate = target as { closest?: (selector: string) => InteractiveLike | null } | null;
  return candidate?.closest?.(INTERACTIVE_SELECTOR) ?? null;
}

export function isInteractiveRootEnabled(root: InteractiveLike): boolean {
  return !root.disabled && !root.hidden && !root.inert && root.getAttribute?.("aria-disabled") !== "true";
}

export function shouldPlayHoverFor(target: EventTarget | null, relatedTarget: EventTarget | null): boolean {
  const next = getInteractiveRoot(target);
  if (!next || !isInteractiveRootEnabled(next)) return false;
  return next !== getInteractiveRoot(relatedTarget);
}
