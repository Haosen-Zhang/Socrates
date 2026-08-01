import { describe, expect, it } from "bun:test";
import { deriveWindowChromeLayout, desktopPlatform } from "./windowChrome";

describe("window chrome layout", () => {
  it("fully removes a hidden sidebar while keeping the toolbar available", () => {
    expect(deriveWindowChromeLayout({ sidebarHidden: true, fullscreen: false, platform: "macos" })).toEqual({
      sidebarVisible: false,
      toolbarMode: "macos-overlay",
    });
  });

  it("uses the top fullscreen toolbar without reserving traffic-light space", () => {
    expect(deriveWindowChromeLayout({ sidebarHidden: false, fullscreen: true, platform: "macos" })).toEqual({
      sidebarVisible: true,
      toolbarMode: "fullscreen",
    });
  });

  it("keeps non-macOS windows on the standard toolbar layout", () => {
    expect(deriveWindowChromeLayout({ sidebarHidden: false, fullscreen: false, platform: "other" })).toEqual({
      sidebarVisible: true,
      toolbarMode: "standard",
    });
  });
});

describe("desktop platform detection", () => {
  it("recognises macOS without treating iPhone or Windows as desktop macOS", () => {
    expect(desktopPlatform("MacIntel", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macos");
    expect(desktopPlatform("iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("other");
    expect(desktopPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("other");
  });
});
