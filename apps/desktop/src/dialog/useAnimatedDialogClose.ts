import { useEffect, useRef, useState } from "react";

/** Let modal close transitions finish before their parent unmounts the dialog. */
export function useAnimatedDialogClose(onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);
  return {
    closing,
    close: () => {
      if (closing) return;
      setClosing(true);
      timeoutRef.current = window.setTimeout(onClose, 150);
    },
  };
}
