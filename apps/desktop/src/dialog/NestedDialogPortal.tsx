import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { trappedFocusIndex } from "./dialogLayer";

const FOCUSABLE_SELECTOR = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableElements(panel: HTMLElement): HTMLElement[] {
	return Array.from(
		panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
	).filter(
		(element) =>
			element.getAttribute("aria-hidden") !== "true" && element.tabIndex >= 0,
	);
}

export default function NestedDialogPortal({
	ariaLabel,
	className,
	children,
	onClose,
}: {
	ariaLabel: string;
	className: string;
	children: ReactNode;
	onClose: () => void;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef(onClose);
	closeRef.current = onClose;
	const portalHost =
		typeof document === "undefined"
			? null
			: document.querySelector<HTMLElement>(".pixel-app");

	useLayoutEffect(() => {
		if (!portalHost || !panelRef.current) return;
		const restoreFocusTo = document.activeElement as HTMLElement | null;
		const panel = panelRef.current;
		(focusableElements(panel)[0] ?? panel).focus();

		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeRef.current();
				return;
			}
			if (event.key !== "Tab") return;
			const focusables = focusableElements(panel);
			const activeIndex = focusables.indexOf(
				document.activeElement as HTMLElement,
			);
			const targetIndex = trappedFocusIndex(
				activeIndex,
				focusables.length,
				event.shiftKey,
			);
			if (targetIndex === null) return;
			event.preventDefault();
			focusables[targetIndex]?.focus();
		};

		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			restoreFocusTo?.focus?.();
		};
	}, [portalHost]);

	if (!portalHost) return null;

	return createPortal(
		<div
			className="pixel-dialog-backdrop"
			data-dialog-layer="nested"
			role="presentation"
			onMouseDown={(event) => {
				event.stopPropagation();
				if (event.target === event.currentTarget) closeRef.current();
			}}
		>
			<div
				ref={panelRef}
				className={className}
				role="dialog"
				aria-modal="true"
				aria-label={ariaLabel}
				tabIndex={-1}
				onMouseDown={(event) => event.stopPropagation()}
			>
				{children}
			</div>
		</div>,
		portalHost,
	);
}
