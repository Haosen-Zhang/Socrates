import { describe, expect, it } from "bun:test";
import { hasOpenNestedDialog, trappedFocusIndex } from "./dialogLayer";

describe("nested dialog ownership", () => {
	it("keeps the Settings dialog from handling keys owned by a nested dialog", () => {
		expect(
			hasOpenNestedDialog({ querySelector: () => ({}) as Element }),
		).toBeTrue();
		expect(hasOpenNestedDialog({ querySelector: () => null })).toBeFalse();
	});
});

describe("nested dialog focus trap", () => {
	it("wraps forward and reverse tab navigation at the dialog edges", () => {
		expect(trappedFocusIndex(2, 3, false)).toBe(0);
		expect(trappedFocusIndex(0, 3, true)).toBe(2);
	});

	it("moves focus into the dialog when it starts outside the focusable set", () => {
		expect(trappedFocusIndex(-1, 3, false)).toBe(0);
		expect(trappedFocusIndex(-1, 3, true)).toBe(2);
	});

	it("leaves ordinary in-dialog tab navigation to the browser", () => {
		expect(trappedFocusIndex(1, 3, false)).toBeNull();
		expect(trappedFocusIndex(1, 3, true)).toBeNull();
		expect(trappedFocusIndex(-1, 0, false)).toBeNull();
	});
});
