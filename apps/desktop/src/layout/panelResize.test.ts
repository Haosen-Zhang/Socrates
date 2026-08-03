import { describe, expect, it } from "bun:test";
import { clampPanelSize, keyboardPanelSize } from "./panelResize";

describe("panelResize", () => {
  it("clamps sizes and handles both panel edges", () => {
    expect(clampPanelSize(99, 180, 480)).toBe(180);
    expect(clampPanelSize(999, 180, 480)).toBe(480);
    expect(keyboardPanelSize(256, "ArrowRight", "end", 180, 480)).toBe(272);
    expect(keyboardPanelSize(420, "ArrowLeft", "start", 300, 640)).toBe(436);
    expect(keyboardPanelSize(420, "Escape", "start", 300, 640)).toBeNull();
  });
});
