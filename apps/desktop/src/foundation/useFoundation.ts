import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { isImeInteraction, type ImeState } from "./interaction";

/** UI-only state: the parent remains the sole owner of selection and open state. */
export function useImeGuard() {
  const state = useRef<ImeState>({ composing: false, lastCompositionEndAt: -Infinity });
  const isComposing = (event: Event) => isImeInteraction(event as KeyboardEvent, state.current);
  return {
    isComposing,
    onCompositionStart: () => { state.current.composing = true; },
    onCompositionEnd: () => {
      state.current.composing = false;
      state.current.lastCompositionEndAt = Date.now();
    },
    onKeyDownCapture: (event: ReactKeyboardEvent) => {
      if ((event.key === "Enter" || event.key === "Escape") && isComposing(event.nativeEvent)) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
}

export function useNarrowViewport() {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(max-width: 900px)").matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

/** Keep inherited theme variables and native <dialog> top-layer visibility. */
export function portalContainer(anchor?: HTMLElement | null): HTMLElement | undefined {
  if (typeof document === "undefined") return undefined;
  const active = anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  return active?.closest<HTMLElement>(anchor ? "dialog" : "dialog[open]") ??
    active?.closest<HTMLElement>(".pixel-app") ??
    document.querySelector<HTMLElement>(".pixel-app") ?? undefined;
}

export function usePortalHost() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const anchorRef = useCallback((element: HTMLElement | null) => {
    if (element) setContainer(portalContainer(element) ?? null);
  }, []);
  return { container, anchorRef };
}
