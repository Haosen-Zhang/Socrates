import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostLedgerView, TaskBudget, type RoomCostView } from "./RoomCostPanel";
import { providerPriceProtocol, syntheticPricePreview } from "./ProviderPrices";
import InvocationReconciliation from "./InvocationReconciliation";
import type { InvocationRecord } from "@socrates/core";

const unknownInvocation: InvocationRecord = {
  invocationId: "unknown-call", logicalStepId: "step", attemptNo: 1, roomId: "room", rootTaskId: "task", runId: "run", agentId: "agent",
  purpose: "respond", providerConnectionId: "provider", modelId: "model", runProfileVersion: "profile-v1", traceId: "trace", spanId: "span",
  status: "outcome_unknown", amount: null, lineItems: [], unknownItems: ["provider_usage_missing"], adapterVersion: "text_tokens/1",
  priceSnapshotId: "frozen-price", state: "outcome_unknown", usage: null, requestId: "provider-request", finishReason: null, outcome: "unknown",
  createdAt: "2026-11-06T00:00:00.000Z", updatedAt: "2026-11-06T00:00:00.000Z",
};

describe("cost presentation", () => {
  it("shows historical reference estimates without asking the user to reconcile every known-usage call", () => {
    const estimate = { amount: { currency: "USD", atomic: "175000000", scale: 12 as const }, priceSnapshotId: "current-reference", source: "official" as const, reason: "historical_current_reference" };
    const data: RoomCostView = { summary: { invocations: 1, unknownCount: 1, totals: [], estimatedTotals: [estimate.amount], outcomeUnknownCount: 0, unpricedCount: 0,
      byAgent: [], usage: {}, historicalUnknownCount: 0 }, tasks: [], invocations: [{ ...unknownInvocation, state: "finished", status: "unpriced", referenceEstimate: estimate }] };
    const html = renderToStaticMarkup(<CostLedgerView data={data} />);
    expect(html).toContain("参考估算"); expect(html).toContain("USD 0.000175");
    expect(html).not.toContain("次待对账"); expect(html).not.toContain("人工账单对账");
    expect(html).toContain("无需逐条填写账单");
  });
  it("shows known subtotal and unresolved calls without presenting an exact total", () => {
    const data: RoomCostView = {
      summary: { invocations: 2, unknownCount: 1, totals: [{ currency: "USD", atomic: "8050000000", scale: 12 }], byAgent: [], usage: {}, historicalUnknownCount: 3 },
      tasks: [], invocations: [],
    };
    const html = renderToStaticMarkup(<CostLedgerView data={data} />);
    expect(html).toContain("已知金额");
    expect(html).toContain("USD 0.00805");
    expect(html).toContain("1 次待对账");
    expect(html).toContain("3 条历史用量");
    expect(html).not.toContain("全部总额");
  });

  it("keeps proxy prices distinct from official Responses and Anthropic prices", () => {
    expect(providerPriceProtocol({ type: "openai_compatible", baseUrl: "https://api.openai.com/v1" })).toBe("openai_responses");
    expect(providerPriceProtocol({ type: "openai_compatible", baseUrl: "https://proxy.example/v1" })).toBe("openai_chat_completions");
    expect(providerPriceProtocol({ type: "openai_compatible", baseUrl: "https://api.openai.com.proxy.example/v1" })).toBe("openai_chat_completions");
    expect(providerPriceProtocol({ type: "anthropic", baseUrl: "https://api.anthropic.com" })).toBe("anthropic_messages");
  });

  it("keeps the synthetic preview precise for tiny rates", () => {
    expect(syntheticPricePreview("0.5", "2")).toBe("2500000000");
    expect(syntheticPricePreview("0.000000000001", "0.000000000001")).toBe("2");
    expect(syntheticPricePreview("", "2")).toBeNull();
  });

  it("resumes a paused task by monetary budget without asking for a token limit", () => {
    const task: RoomCostView["tasks"][number] = { rootTaskId: "original-task", kind: "team", status: "paused", maxOutputTokens: 512,
      budget: { rootTaskId: "original-task", roomId: "room", mode: "soft_limit", limitAtomic: "1000000000000", parentId: null, revision: 2,
        settledKnownAtomic: "600000000000", activeReservationsAtomic: "250000000000", unresolvedExposureAtomic: "0", availableAtomic: "150000000000", unknownCount: 0, breached: false, blockedReason: "cost_budget_insufficient" } };
    const html = renderToStaticMarkup(<TaskBudget task={task} onRefresh={() => {}} />);
    expect(html).toContain("恢复原任务");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("恢复时输出上限");
    expect(html).toContain("输出额度由应用自动管理");
    expect(html).toContain("USD 0.15");
    expect(html).toContain("title=\"original-task\"");
  });

  it("requires a blank amount, explicit bill confirmation and evidence for manual reconciliation", () => {
    const html = renderToStaticMarkup(<InvocationReconciliation invocation={unknownInvocation} onSaved={() => {}} />);
    expect(html).toContain("人工账单对账");
    expect(html).toContain("账单依据或对账原因");
    expect(html).toContain('type="checkbox"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存人工对账<\/button>/);
    expect(html).toMatch(/aria-label="该次请求的账单总金额"[^>]*value=""/);
  });

  it("shows manual evidence without rewriting the original unknown usage record", () => {
    const data: RoomCostView = { summary: { invocations: 1, unknownCount: 0, totals: [{ currency: "USD", atomic: "200000000", scale: 12 }], byAgent: [], usage: {}, historicalUnknownCount: 0 },
      tasks: [], invocations: [{ ...unknownInvocation, reconciliation: { amount: { currency: "USD", atomic: "200000000", scale: 12 }, requestId: "manual-1", reason: "Bill #fixture-1" } }] };
    const html = renderToStaticMarkup(<CostLedgerView data={data} />);
    expect(html).toContain("人工确认的供应商账单金额");
    expect(html).toContain("USD 0.0002");
    expect(html).toContain("Bill #fixture-1");
    expect(html).toContain("结果待对账");
    expect(html).toContain("frozen-price");
    expect(html).toContain("供应商未返回完整用量");
    expect(renderToStaticMarkup(<InvocationReconciliation invocation={{ ...unknownInvocation, state: "not_sent" }} onSaved={() => {}} />)).toBe("");
  });
});
