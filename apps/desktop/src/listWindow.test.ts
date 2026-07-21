import { describe, expect, it } from "bun:test";
import { DEFAULT_WINDOW_SIZE, expandWindow, windowTail } from "./listWindow";

const seq = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("windowTail", () => {
  it("returns everything when under the limit (no data loss, no折叠)", () => {
    expect(windowTail(seq(5), 80)).toEqual({ visible: [0, 1, 2, 3, 4], hiddenCount: 0 });
    expect(windowTail([], 80)).toEqual({ visible: [], hiddenCount: 0 });
  });

  it("keeps the newest N in original order and reports the hidden count", () => {
    const w = windowTail(seq(100), 80);
    expect(w.visible).toHaveLength(80);
    expect(w.visible[0]).toBe(20); // 最早可见项
    expect(w.visible[w.visible.length - 1]).toBe(99); // 最新项始终可见
    expect(w.hiddenCount).toBe(20);
  });

  it("visible + hidden always reconstructs the full list (nothing dropped)", () => {
    const items = seq(250);
    const w = windowTail(items, DEFAULT_WINDOW_SIZE);
    expect([...items.slice(0, w.hiddenCount), ...w.visible]).toEqual(items);
  });

  it("limit <= 0 degrades to rendering everything rather than hiding all", () => {
    expect(windowTail(seq(3), 0)).toEqual({ visible: [0, 1, 2], hiddenCount: 0 });
  });
});

describe("expandWindow", () => {
  it("grows by a step and never exceeds the total", () => {
    expect(expandWindow(80, 250)).toBe(160);
    expect(expandWindow(200, 250)).toBe(250);
    expect(expandWindow(250, 250)).toBe(250);
  });
});
