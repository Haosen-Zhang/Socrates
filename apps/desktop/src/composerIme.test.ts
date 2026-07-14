import { describe, expect, it } from "bun:test";
import { shouldSubmitComposerEnter } from "./composerIme";

describe("shouldSubmitComposerEnter", () => {
  const enter = { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 };

  it("submits a plain Enter but keeps Shift+Enter as a newline", () => {
    expect(shouldSubmitComposerEnter(enter, { composing: false, lastCompositionEndAt: 0, now: 1_000 })).toBeTrue();
    expect(
      shouldSubmitComposerEnter({ ...enter, shiftKey: true }, { composing: false, lastCompositionEndAt: 0, now: 1_000 }),
    ).toBeFalse();
  });

  it("never submits while the browser or component reports composition", () => {
    expect(shouldSubmitComposerEnter(enter, { composing: true, lastCompositionEndAt: 0, now: 1_000 })).toBeFalse();
    expect(
      shouldSubmitComposerEnter({ ...enter, isComposing: true }, { composing: false, lastCompositionEndAt: 0, now: 1_000 }),
    ).toBeFalse();
    expect(
      shouldSubmitComposerEnter({ ...enter, keyCode: 229 }, { composing: false, lastCompositionEndAt: 0, now: 1_000 }),
    ).toBeFalse();
  });

  it("swallows the composition-confirm Enter that arrives just after compositionend", () => {
    expect(
      shouldSubmitComposerEnter(enter, { composing: false, lastCompositionEndAt: 950, now: 1_000 }),
    ).toBeFalse();
    expect(
      shouldSubmitComposerEnter(enter, { composing: false, lastCompositionEndAt: 850, now: 1_000 }),
    ).toBeTrue();
  });
});
