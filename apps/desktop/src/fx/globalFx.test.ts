import { describe, expect, it } from "bun:test";
import { particlePointForClick } from "./GlobalFxLayer";

describe("particlePointForClick", () => {
  it("uses the pointer click coordinates exactly", () => {
    expect(particlePointForClick({ detail: 1, button: 0, clientX: 42, clientY: 84 })).toEqual({ x: 42, y: 84 });
  });

  it("ignores keyboard, secondary, and invalid-coordinate clicks", () => {
    expect(particlePointForClick({ detail: 0, button: 0, clientX: 0, clientY: 0 })).toBeNull();
    expect(particlePointForClick({ detail: 1, button: 2, clientX: 10, clientY: 20 })).toBeNull();
    expect(particlePointForClick({ detail: 1, button: 0, clientX: Number.NaN, clientY: 20 })).toBeNull();
  });
});
