import { describe, expect, it } from "bun:test";
import { clampComposerHeight, composerHeightFromKey, composerHeightFromPointer } from "./composerMachine";

describe("resizable composer state", () => {
  it("clamps to 104px and the smaller of 360px or 40vh", () => {
    expect(clampComposerHeight(20, 800)).toBe(104);
    expect(clampComposerHeight(500, 800)).toBe(320);
    expect(clampComposerHeight(500, 1200)).toBe(360);
  });

  it("resizes upward from the top handle and supports 8/24px keyboard steps", () => {
    expect(composerHeightFromPointer({ startHeight: 140, startY: 500, currentY: 450, viewportHeight: 900 })).toBe(190);
    expect(composerHeightFromKey(140, "ArrowUp", false, 900)).toBe(148);
    expect(composerHeightFromKey(140, "ArrowDown", true, 900)).toBe(116);
  });
});
