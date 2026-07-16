import { describe, expect, it } from "bun:test";
import { shouldPlayHoverFor } from "./interactiveEntry";

type FakeRoot = {
  disabled?: boolean;
  hidden?: boolean;
  inert?: boolean;
  getAttribute(name: string): string | null;
};

function root(attributes: Record<string, string> = {}): FakeRoot {
  return {
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function targetFor(value: FakeRoot | null): EventTarget {
  return { closest: () => value } as unknown as EventTarget;
}

describe("shouldPlayHoverFor", () => {
  it("plays only when entering a different enabled interactive root", () => {
    const a = root();
    const b = root();
    expect(shouldPlayHoverFor(targetFor(a), null)).toBe(true);
    expect(shouldPlayHoverFor(targetFor(a), targetFor(a))).toBe(false);
    expect(shouldPlayHoverFor(targetFor(b), targetFor(a))).toBe(true);
    expect(shouldPlayHoverFor(null, targetFor(a))).toBe(false);
    expect(shouldPlayHoverFor(targetFor(a), null)).toBe(true);
  });

  it("ignores disabled, aria-disabled, hidden, and inert controls", () => {
    const disabled = Object.assign(root(), { disabled: true });
    const hidden = Object.assign(root(), { hidden: true });
    const inert = Object.assign(root(), { inert: true });
    expect(shouldPlayHoverFor(targetFor(disabled), null)).toBe(false);
    expect(shouldPlayHoverFor(targetFor(root({ "aria-disabled": "true" })), null)).toBe(false);
    expect(shouldPlayHoverFor(targetFor(hidden), null)).toBe(false);
    expect(shouldPlayHoverFor(targetFor(inert), null)).toBe(false);
  });
});
