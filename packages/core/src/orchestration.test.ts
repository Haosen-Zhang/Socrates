import { describe, expect, it } from "bun:test";
import type { GatewayRequest, ModelGateway } from "./chat";
import {
  buildDiscussionMessages,
  buildTurnPlan,
  buildTurnSystem,
  runTask,
  selectSpeaker,
  validateTaskConfig,
  type OrchestrationAgent,
  type OrchestrationEvent,
  type TaskConfig,
} from "./orchestration";

const agent = (id: string, name: string): OrchestrationAgent => ({
  id,
  displayName: name,
  modelId: `model-${id}`,
  role: `${name}的角色`,
  systemPrompt: "",
  providerType: "openai_compatible",
  baseUrl: "https://x",
  apiKey: "sk",
});

const AGENTS = { a: agent("a", "甲"), b: agent("b", "乙") };

const rr = (over: Partial<TaskConfig> = {}): TaskConfig => ({
  prompt: "讨论问题",
  mode: "round_robin",
  speakingOrder: ["a", "b"],
  maxRounds: 2,
  finalSummarizerId: "a",
  ...over,
});

const debate = (over: Partial<TaskConfig> = {}): TaskConfig => ({
  prompt: "辩论问题",
  mode: "debate",
  speakingOrder: [],
  finalSummarizerId: "",
  maxRounds: 2,
  debate: { proposerId: "a", skepticId: "b", synthesizerId: "a", judgeId: "b" },
  ...over,
});

function echoGateway(seen?: GatewayRequest[]): ModelGateway {
  return async function* (req) {
    seen?.push(req);
    yield { type: "delta", text: `${req.modelId}说` };
    yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
  };
}

async function collect(events: AsyncIterable<OrchestrationEvent>) {
  const out: OrchestrationEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("selectSpeaker", () => {
  it("cycles the order", () => {
    const order = ["a", "b", "c"];
    expect([0, 1, 2, 3, 4, 5].map((i) => selectSpeaker(order, i))).toEqual([
      "a", "b", "c", "a", "b", "c",
    ]);
  });
});

describe("validateTaskConfig", () => {
  const room = ["a", "b"];
  it("rejects bad round-robin configs", () => {
    expect(validateTaskConfig(rr({ prompt: " " }), room)).not.toBeNull();
    expect(validateTaskConfig(rr({ maxRounds: 0 }), room)).not.toBeNull();
    expect(validateTaskConfig(rr({ maxRounds: 2.5 }), room)).not.toBeNull();
    expect(validateTaskConfig(rr({ speakingOrder: ["a", "外人"] }), room)).not.toBeNull();
    expect(validateTaskConfig(rr({ finalSummarizerId: "外人" }), room)).not.toBeNull();
    expect(validateTaskConfig(rr(), room)).toBeNull();
  });
  it("rejects bad debate configs", () => {
    expect(validateTaskConfig(debate({ debate: undefined }), room)).not.toBeNull();
    expect(
      validateTaskConfig(
        debate({ debate: { proposerId: "外人", skepticId: "b", synthesizerId: "a", judgeId: "b" } }),
        room,
      ),
    ).not.toBeNull();
    expect(validateTaskConfig(debate(), room)).toBeNull();
  });
});

describe("buildTurnPlan / debate", () => {
  const specOf = (p: ReturnType<typeof buildTurnPlan>) =>
    p.map((s) => [s.agentId, s.round, s.duty, s.phase]);

  it("maxRounds=2 reproduces the docs/04 §7 example", () => {
    expect(specOf(buildTurnPlan(debate()))).toEqual([
      ["a", 1, "propose", "discussion"],
      ["b", 1, "critique", "discussion"],
      ["a", 1, "synthesize", "discussion"],
      ["b", 2, "critique", "discussion"],
      ["a", 2, "propose", "discussion"],
      ["b", 2, "judge", "summary"],
    ]);
  });

  it("maxRounds=1 degrades to propose/critique/judge", () => {
    expect(specOf(buildTurnPlan(debate({ maxRounds: 1 })))).toEqual([
      ["a", 1, "propose", "discussion"],
      ["b", 1, "critique", "discussion"],
      ["b", 1, "judge", "summary"],
    ]);
  });

  it("middle rounds end with synthesize, only the last with judge", () => {
    const plan = buildTurnPlan(debate({ maxRounds: 3 }));
    expect(plan).toHaveLength(9);
    expect(plan.filter((s) => s.duty === "judge")).toHaveLength(1);
    expect(plan.at(-1)!.duty).toBe("judge");
    expect(plan[2].duty).toBe("synthesize");
    expect(plan[5].duty).toBe("synthesize");
  });
});

describe("buildTurnSystem", () => {
  it("debate duties include the output contract, judge does not", () => {
    const a = { displayName: "甲", role: "", systemPrompt: "" };
    expect(buildTurnSystem(a, { duty: "propose", round: 1 }, 2)).toContain("## Position");
    expect(buildTurnSystem(a, { duty: "critique", round: 1 }, 2)).toContain("## Critique");
    expect(buildTurnSystem(a, { duty: "synthesize", round: 1 }, 2)).toContain("## Proposal");
    expect(buildTurnSystem(a, { duty: "judge", round: 2 }, 2)).toContain("裁决");
    expect(buildTurnSystem(a, { duty: "judge", round: 2 }, 2)).not.toContain("## Position");
  });
  it("round-robin summary duty replaces discussion duty", () => {
    const sys = buildTurnSystem(
      { displayName: "甲", role: "", systemPrompt: "提示词" },
      { duty: "summarize", round: 2 },
      2,
    );
    expect(sys).toContain("提示词");
    expect(sys).toContain("最终总结者");
    expect(sys).not.toContain("圆桌讨论");
  });
});

describe("runTask / round robin", () => {
  it("runs order × rounds discussion turns then the summary turn", async () => {
    const events = await collect(runTask(rr(), { agents: AGENTS, gateway: echoGateway() }));
    const starts = events.filter((e) => e.type === "turn_started");
    expect(starts.map((s) => [s.agentId, s.round, s.phase])).toEqual([
      ["a", 1, "discussion"],
      ["b", 1, "discussion"],
      ["a", 2, "discussion"],
      ["b", 2, "discussion"],
      ["a", 2, "summary"],
    ]);
    expect(events.at(-1)).toEqual({ type: "task_completed" });
    const completed = events.filter((e) => e.type === "turn_completed");
    expect(completed).toHaveLength(5);
    expect(completed[0].usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("assembles context: task + labeled prior turns, per-turn duty system", async () => {
    const seen: GatewayRequest[] = [];
    await collect(runTask(rr({ maxRounds: 1 }), { agents: AGENTS, gateway: echoGateway(seen) }));
    expect(seen).toHaveLength(3);
    expect(seen[0].messages[0].content).toContain("任务：\n讨论问题");
    expect(seen[0].messages[0].content).not.toContain("已有讨论");
    expect(seen[1].messages[0].content).toContain("【甲 · 第1轮】\nmodel-a说");
    expect(seen[2].messages[0].content).toContain("【乙 · 第1轮】\nmodel-b说");
    expect(seen[0].system).toContain("你是「甲」，角色：甲的角色");
    expect(seen[0].system).toContain("第 1/1 轮");
    expect(seen[2].system).toContain("最终总结者");
    expect(seen[2].modelId).toBe("model-a");
  });

  it("stops the task when a turn fails", async () => {
    let calls = 0;
    const flaky: ModelGateway = async function* () {
      calls++;
      if (calls === 2) {
        yield { type: "error", message: "rate limited" };
        return;
      }
      yield { type: "delta", text: "ok" };
      yield { type: "done" };
    };
    const events = await collect(runTask(rr(), { agents: AGENTS, gateway: flaky }));
    expect(events.map((e) => e.type)).toContain("turn_failed");
    expect(events.at(-1)?.type).toBe("task_failed");
    expect(calls).toBe(2);
  });

  it("builds single-message transcript to avoid role alternation issues", () => {
    const msgs = buildDiscussionMessages("任务A", [
      { agentId: "a", agentName: "甲", round: 1, content: "观点1" },
      { agentId: "b", agentName: "乙", round: 1, content: "观点2" },
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toContain("【甲 · 第1轮】\n观点1");
    expect(msgs[0].content).toContain("【乙 · 第1轮】\n观点2");
  });
});

describe("runTask / debate", () => {
  it("streams the doc sequence and judge sees the whole debate", async () => {
    const seen: GatewayRequest[] = [];
    const events = await collect(runTask(debate(), { agents: AGENTS, gateway: echoGateway(seen) }));
    const starts = events.filter((e) => e.type === "turn_started");
    expect(starts.map((s) => [s.agentId, s.duty])).toEqual([
      ["a", "propose"],
      ["b", "critique"],
      ["a", "synthesize"],
      ["b", "critique"],
      ["a", "propose"],
      ["b", "judge"],
    ]);
    expect(events.at(-1)).toEqual({ type: "task_completed" });
    // 裁决者的上下文包含之前全部 5 个 turn
    const judgeReq = seen.at(-1)!;
    expect(judgeReq.system).toContain("裁决");
    expect(judgeReq.messages[0].content.match(/【/g)).toHaveLength(5);
  });
});
