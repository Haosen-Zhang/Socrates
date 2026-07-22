import { describe, expect, it } from "bun:test";
import {
  INITIAL_SETTINGS_OVERLAY,
  closeSettings,
  isSettingsShortcut,
  openSettings,
} from "./settingsOverlay";

describe("settings overlay is a singleton", () => {
  it("repeated opens focus the existing instance instead of stacking a new one", () => {
    const first = openSettings(INITIAL_SETTINGS_OVERLAY);
    const second = openSettings(first);
    const third = openSettings(second);
    expect([first.open, second.open, third.open]).toEqual([true, true, true]);
    // focusNonce 单调递增 —— 调用方据此重新聚焦，而不是创建第二个实例
    expect(first.focusNonce).toBe(1);
    expect(second.focusNonce).toBe(2);
    expect(third.focusNonce).toBe(3);
  });

  it("opening with a section jumps there; opening without one keeps the last section", () => {
    const atNetwork = openSettings(INITIAL_SETTINGS_OVERLAY, "network");
    expect(atNetwork.section).toBe("network");
    expect(openSettings(atNetwork).section).toBe("network");
    expect(openSettings(atNetwork, "providers").section).toBe("providers");
  });
});

describe("closing settings", () => {
  it("closes without discarding the last section", () => {
    const opened = openSettings(INITIAL_SETTINGS_OVERLAY, "appearance");
    const closed = closeSettings(opened);
    expect(closed.open).toBeFalse();
    expect(closed.section).toBe("appearance");
    expect(openSettings(closed).section).toBe("appearance");
  });

  it("overlay state carries no navigation target — the underlying room is untouched", () => {
    const closed = closeSettings(openSettings(INITIAL_SETTINGS_OVERLAY));
    expect(Object.keys(closed).sort()).toEqual(["focusNonce", "open", "section"]);
  });
});

describe("settings shortcut", () => {
  it("matches Cmd+, on macOS and Ctrl+, elsewhere", () => {
    expect(isSettingsShortcut({ key: ",", metaKey: true, ctrlKey: false })).toBeTrue();
    expect(isSettingsShortcut({ key: ",", metaKey: false, ctrlKey: true })).toBeTrue();
  });

  it("ignores a bare comma and other modified keys", () => {
    expect(isSettingsShortcut({ key: ",", metaKey: false, ctrlKey: false })).toBeFalse();
    expect(isSettingsShortcut({ key: "s", metaKey: true, ctrlKey: false })).toBeFalse();
  });
});
