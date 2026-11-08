import { containsCredentialMaterial } from "../security/redaction";
/** Export is a separate allowlisted/redacted boundary, never a filesystem bundle. */
export function arenaExport<T>(value: T): { data: T; redacted: boolean } {
	let redacted = false;
	function walk(item: unknown): unknown {
		if (typeof item === "string") {
			if (containsCredentialMaterial(item)) {
				redacted = true;
				return "[REDACTED credential material]";
			}
			if (/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/.test(item)) {
				redacted = true;
				return "[REDACTED local path]";
			}
			return item;
		}
		if (Array.isArray(item)) return item.map(walk);
		if (item && typeof item === "object")
			return Object.fromEntries(
				Object.entries(item).map(([k, v]) => [k, walk(v)]),
			);
		return item;
	}
	return {
		data: walk(value) as T,
		get redacted() {
			return redacted;
		},
	};
}
export function arenaCsv(
	rows: Array<{
		taskId: string;
		variantId: string;
		repeat: number;
		status: string;
		outcome?: string;
		knownAtomic: string;
		estimatedAtomic: string;
		unknownCount: number;
	}>,
): string {
	const fields = [
		"taskId",
		"variantId",
		"repeat",
		"status",
		"outcome",
		"knownAtomic",
		"estimatedAtomic",
		"unknownCount",
	] as const;
	const cell = (value: unknown) => {
		const text = String(value ?? "");
		return `"${(/^[=+@\-\t\r]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
	};
	return [
		fields.join(","),
		...rows.map((row) => fields.map((key) => cell(row[key])).join(",")),
	].join("\n");
}
