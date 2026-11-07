import { describe, expect, it } from "bun:test";
import { QuoteRequestGuard, budgetAtomic, formatAtomic, quoteBinding, submittedCostOptions } from "./ui-state";

describe("cost input and quote ownership", () => {
  it("preserves very small dollar amounts without floating point rounding", () => {
    expect(budgetAtomic("0.00805")).toBe("8050000000");
    expect(budgetAtomic("0.000000000001")).toBe("1");
    expect(formatAtomic("8050000000", "USD", true)).toBe("USD 0.00805");
    expect(formatAtomic("1")).toBe("USD <0.000001");
    expect(formatAtomic("0")).toBe("USD 0.00");
    expect(() => budgetAtomic("1e3")).toThrow();
    expect(() => budgetAtomic("-1")).toThrow();
    expect(() => budgetAtomic("0.0000000000001")).toThrow();
  });

  it("rejects a late quote after the user changes room or draft", () => {
    const guard = new QuoteRequestGuard();
    const roomA = guard.begin("room-a:old-draft");
    const roomB = guard.begin("room-b:new-draft");
    expect(guard.accepts(roomA)).toBe(false);
    expect(guard.accepts(roomB)).toBe(true);
    guard.invalidate();
    expect(guard.accepts(roomB)).toBe(false);
  });

  it("invalidates quote bindings for model, files and target changes", () => {
    const request = { roomId: "a", content: "task", mentions: [], intent: "execute", maxOutputTokens: 1024 };
    const first = quoteBinding(request, { modelId: "model-a" });
    expect(quoteBinding(request, { modelId: "model-b" })).not.toBe(first);
    expect(quoteBinding({ ...request, workspaceRefIds: ["file"] }, { modelId: "model-a" })).not.toBe(first);
    expect(quoteBinding({ ...request, mentions: [{ type: "agent", agentId: "other" }] }, { modelId: "model-a" })).not.toBe(first);
    expect(quoteBinding({ ...request, verificationPlanId: "plan-v2" }, { modelId: "model-a" })).not.toBe(first);
    expect(quoteBinding({ ...request, routingCandidateId: "reviewed-workflow" }, { modelId: "model-a" })).not.toBe(first);
  });

  it("does not authorize a stale or expired quote for a budgeted send", () => {
    const binding = "current";
    const options = { budget: { mode: "soft_limit" as const, limitAtomic: "1000000000000" }, maxOutputTokens: 1024 };
    expect(() => submittedCostOptions({ binding: "old", options, expiresAt: 2000 }, binding, 1000)).toThrow("quote_required");
    expect(() => submittedCostOptions({ binding, options: { ...options, quoteId: "quote" }, expiresAt: 500 }, binding, 1000)).toThrow("quote_expired");
    expect(submittedCostOptions({ binding, options: { ...options, quoteId: "quote" }, expiresAt: 2000 }, binding, 1000).quoteId).toBe("quote");
    expect(() => submittedCostOptions({ binding, options, expiresAt: 2000 }, binding, 1000)).toThrow("quote_required");
    expect(() => submittedCostOptions({ binding, options: { ...options, quoteId: "quote" }, expiresAt: Number.NaN }, binding, 1000)).toThrow("quote_expired");
  });
});
