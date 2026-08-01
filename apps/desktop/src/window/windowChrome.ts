import { useEffect, useState } from "react";

export type DesktopPlatform = "macos" | "other";
export type WindowToolbarMode = "macos-overlay" | "fullscreen" | "standard";

export function desktopPlatform(platform: string, userAgent: string): DesktopPlatform {
  return platform.startsWith("Mac") && !/iPhone|iPad|iPod/u.test(userAgent) ? "macos" : "other";
}

export function deriveWindowChromeLayout(input: {
  sidebarHidden: boolean;
  fullscreen: boolean;
  platform: DesktopPlatform;
}): { sidebarVisible: boolean; toolbarMode: WindowToolbarMode } {
  return {
    sidebarVisible: !input.sidebarHidden,
    toolbarMode: input.fullscreen
      ? "fullscreen"
      : input.platform === "macos"
        ? "macos-overlay"
        : "standard",
  };
}

export function useWindowChromeState(): { fullscreen: boolean; platform: DesktopPlatform } {
  const [fullscreen, setFullscreen] = useState(false);
  const [platform] = useState<DesktopPlatform>(() => {
    if (typeof navigator === "undefined") return "other";
    return desktopPlatform(navigator.platform, navigator.userAgent);
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        const sync = async () => {
          const next = await appWindow.isFullscreen();
          if (!disposed) setFullscreen(next);
        };
        await sync();
        unlisten = await appWindow.onResized(() => void sync());
        if (disposed) unlisten();
      })
      .catch(() => {
        // Browser previews do not expose Tauri window APIs and use standard mode.
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { fullscreen, platform };
}
