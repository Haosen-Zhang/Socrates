export const NESTED_DIALOG_SELECTOR = '[data-dialog-layer="nested"]';

type QueryRoot = Pick<ParentNode, "querySelector">;

export function hasOpenNestedDialog(root: QueryRoot): boolean {
	return root.querySelector(NESTED_DIALOG_SELECTOR) !== null;
}

export function trappedFocusIndex(
	activeIndex: number,
	focusableCount: number,
	reverse: boolean,
): number | null {
	if (focusableCount < 1) return null;
	if (reverse && activeIndex <= 0) return focusableCount - 1;
	if (!reverse && (activeIndex < 0 || activeIndex >= focusableCount - 1))
		return 0;
	return null;
}
