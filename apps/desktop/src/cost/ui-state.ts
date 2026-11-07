import { decimalToAtomic, type RoomCommandInput, type RoomMention } from "@socrates/core";

export type CostOptions = Pick<RoomCommandInput, "quoteId" | "budget" | "maxOutputTokens">;

export type BoundCostOptions = { binding: string; options: CostOptions; expiresAt: number; error?: string | null };

/** Decimal input is a string throughout; budgets never pass through a Number. */
export function budgetAtomic(value: string): string {
  try { return decimalToAtomic(value.trim()); }
  catch { throw new Error("cost_invalid_amount"); }
}

export function formatAtomic(value: string | null | undefined, currency = "USD", expanded = false): string {
  if (value == null || !/^-?\d+$/.test(value)) return "—";
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(13, "0");
  const whole = digits.slice(0, -12);
  const fraction = digits.slice(-12).replace(/0+$/, "");
  const precision = expanded ? 12 : 6;
  const short = fraction.slice(0, precision);
  const truncated = fraction.length > precision;
  if (!negative && whole === "0" && truncated && /^0+$/.test(short)) return `${currency} <0.${"0".repeat(precision - 1)}1`;
  return `${currency} ${negative ? "−" : ""}${whole}${short ? `.${short}` : ".00"}${truncated ? "…" : ""}`;
}

export function quoteBinding(input: {
  roomId: string; content: string; mentions: RoomMention[]; intent: string;
  attachmentIds?: string[]; workspaceRefIds?: string[]; maxOutputTokens?: number;
  budget?: CostOptions["budget"];
}, configuration: unknown): string {
  return JSON.stringify({ ...input, content: input.content.trim(), configuration });
}

export class QuoteRequestGuard {
  private version = 0;
  private binding = "";
  begin(binding: string) { this.binding = binding; return { version: ++this.version, binding }; }
  invalidate() { this.version++; }
  accepts(ticket: { version: number; binding: string }) { return ticket.version === this.version && ticket.binding === this.binding; }
}

export function submittedCostOptions(bound: BoundCostOptions | null, binding: string, now = Date.now()): CostOptions {
  if (!bound || bound.binding !== binding) throw new Error("quote_required");
  if (bound.error) throw new Error(bound.error);
  if (bound.options.budget && !bound.options.quoteId) throw new Error("quote_required");
  if (bound.options.quoteId && (!Number.isFinite(bound.expiresAt) || bound.expiresAt <= now)) throw new Error("quote_expired");
  return bound.options;
}
