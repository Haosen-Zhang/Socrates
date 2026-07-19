import { describe, expect, it } from "bun:test";
import { throttleDecision } from "./useThrottledValue";

describe("throttleDecision", () => {
  it("emits immediately when the interval has fully elapsed", () => {
    expect(throttleDecision(0, 300, 250)).toEqual({ emit: true, delay: 0 });
    expect(throttleDecision(0, 250, 250)).toEqual({ emit: true, delay: 0 });
  });

  it("schedules a tail emit within the window (final value never dropped)", () => {
    expect(throttleDecision(0, 100, 250)).toEqual({ emit: false, delay: 150 });
    expect(throttleDecision(1000, 1010, 250)).toEqual({ emit: false, delay: 240 });
  });
});
