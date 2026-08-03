import { describe, expect, it } from "bun:test";
import { UNAVAILABLE_USAGE } from "@socrates/core";
import { renderToStaticMarkup } from "react-dom/server";
import RoomOverview from "./RoomOverview";

describe("RoomOverview", () => {
  it("groups per-agent usage and member management in the overview", () => {
    const html = renderToStaticMarkup(
      <RoomOverview
        agents={[{ id: "agent-1", nickname: "月面记录官", avatar: "/avatar.png", modelId: "gpt-5.4", role: "执行者", contextWindowTokens: 1280, reasoningEffort: "high" }]}
        usage={[{
          agentId: "agent-1",
          current: { ...UNAVAILABLE_USAGE, inputTokens: 320, totalTokens: 320 },
          cumulative: { ...UNAVAILABLE_USAGE, totalTokens: 1840, cachedInputTokens: 240 },
          records: 2,
        }]}
        onManageMembers={() => {}}
      />,
    );

    expect(html).toContain('data-section="usage"');
    expect(html).toContain('data-section="members"');
    expect(html).toContain("月面记录官");
    expect(html).toContain("1,840");
    expect(html).toContain("gpt-5.4");
    expect(html).toContain("25%");
    expect(html).toContain("high");
  });

  it("does not invent unavailable usage", () => {
    const html = renderToStaticMarkup(
      <RoomOverview
        agents={[{ id: "agent-1", nickname: "Agent", avatar: "/avatar.png", modelId: "model", contextWindowTokens: null, reasoningEffort: null }]}
        usage={[]}
        onManageMembers={() => {}}
      />,
    );

    expect(html).toContain("不可用");
  });
});
