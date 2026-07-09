import { describe, expect, it } from "bun:test";
import type { GatewayRequest, ModelGateway } from "./chat";
import {
  buildDiscussionMessages,
  buildTurnSystem,
  runRoundRobin,
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

const cfg = (over: Partial<TaskConfig> = {}): TaskConfig => ({
  prompt: "讨论问题",
  speakingOrder: ["a", "b"],
  maxRounds: 2,
  finalSummarizerId: "a",
  ...over,
});

/** 每次发言输出自己的名字，方便断言 */
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
  it("rejects bad configs", () => {
    const room = ["a", "b"];
    expect(validateTaskConfig(cfg({ prompt: " " }), room)).not.toBeNull();
    expect(validateTaskConfig(cfg({ maxRounds: 0 }), room)).not.toBeNull();
    expect(validateTaskConfig(cfg({ maxRounds: 2.5 }), room)).not.toBeNull();
    expect(validateTaskConfig(cfg({ speakingOrder: ["a", "外人"] }), room)).not.toBeNull();
    expect(validateTaskConfig(cfg({ finalSummarizerId: "外人" }), room)).not.toBeNull();
    expect(validateTaskConfig(cfg(), room)).toBeNull();
  });
});

describe("runRoundRobin", () => {
  it("runs order × rounds discussion turns then the summary turn", async () => {
    const events = await collect(runRoundRobin(cfg(), { agents: AGENTS, gateway: echoGateway() }));
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
    await collect(runRoundRobin(cfg({ maxRounds: 1 }), { agents: AGENTS, gateway: echoGateway(seen) }));
    // 3 个请求：甲、乙、总结（甲）
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
    const events = await collect(runRoundRobin(cfg(), { agents: AGENTS, gateway: flaky }));
    const types = events.map((e) => e.type);
    expect(types).toContain("turn_failed");
    expect(events.at(-1)?.type).toBe("task_failed");
    expect(calls).toBe(2); // 失败后不再继续
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

  it("summary duty replaces discussion duty", () => {
    const sys = buildTurnSystem({ displayName: "甲", role: "", systemPrompt: "提示词" }, "summary", 2, 2);
    expect(sys).toContain("提示词");
    expect(sys).toContain("最终总结者");
    expect(sys).not.toContain("圆桌讨论");
  });
});
