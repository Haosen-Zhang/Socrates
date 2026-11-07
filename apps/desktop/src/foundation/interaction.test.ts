import { describe, expect, it } from "bun:test";
import { isImeInteraction } from "./interaction";

describe("foundation IME protection", () => {
  const inactive = { composing: false, lastCompositionEndAt: -Infinity };

  it("blocks composition signals and WebKit's confirmation key", () => {
    expect(isImeInteraction({}, { ...inactive, composing: true }, 1000)).toBe(true);
    expect(isImeInteraction({ isComposing: true }, inactive, 1000)).toBe(true);
    expect(isImeInteraction({ keyCode: 229 }, inactive, 1000)).toBe(true);
  });

  it("protects the first key after composition ends without trapping later Escape", () => {
    const justEnded = { composing: false, lastCompositionEndAt: 1000 };
    expect(isImeInteraction({}, justEnded, 1050)).toBe(true);
    expect(isImeInteraction({}, justEnded, 1100)).toBe(false);
    expect(isImeInteraction({}, inactive, 1000)).toBe(false);
  });
});
