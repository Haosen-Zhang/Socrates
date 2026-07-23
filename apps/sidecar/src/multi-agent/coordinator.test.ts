import { describe, expect, it } from "bun:test";
import type { ModelGateway, OrchestrationAgent } from "@socrates/core";
import { openDb } from "../db";
import { EventStore } from "../store/event-store";
import { MultiAgentCoordinator } from "./coordinator";
import { MultiTaskStore } from "./task-store";

function setup(outputs: string[]) {
  const db = openDb(":memory:");
  const now = new Date().toISOString();
  db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
  db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 'multi', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
  for (const [position, id] of ["a", "b"].entries()) db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', ?, ?, ?, 1)").run(id, JSON.stringify({ nickname: id, modelId: `model-${id}` }), position);
  let calls = 0;
  const gateway: ModelGateway = async function* () { const value = outputs[calls++] ?? "missing"; yield { type: "delta", text: value }; yield { type: "done", usage: { inputTokens: 1, outputTokens: 2 } }; };
  const resolve = (id: string, snapshot: Record<string, unknown>): OrchestrationAgent => ({ id, nickname: String(snapshot.nickname), modelId: String(snapshot.modelId), role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "http://unused", apiKey: "fixture" });
  const store = new MultiTaskStore(db);
  return { db, store, coordinator: new MultiAgentCoordinator(db, store, new EventStore(db), gateway, resolve), calls: () => calls };
}

describe("MultiAgentCoordinator", () => {
  it("runs discussion serially, repairs a plan once and waits for exact approval", async () => {
    const valid = JSON.stringify({ objective: "build", summary: "safe", steps: [{ id: "1", title: "edit", description: "change", files: ["src/a.ts"], commands: [], risks: [], verification: ["bun test"] }], evidence: [] });
    const { store, coordinator, calls } = setup(["A view", "B view", "not-json", valid]);
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    const events: string[] = [];
    await coordinator.run(task.id, (event) => { events.push(event.type); });
    expect(store.get(task.id)?.state).toBe("awaiting_plan_approval");
    expect(store.getPlan(task.id)?.content.objective).toBe("build");
    expect(calls()).toBe(4);
    expect(events.filter((type) => type === "turn_completed")).toHaveLength(2);
    expect(store.usageSummaries(task.id).find((item) => item.agentId === "a")?.current.totalTokens).toBe(3);
  });

  it("does not call a provider twice for a completed stable turn", async () => {
    const { store, coordinator, calls } = setup([]);
    const task = coordinator.create({ sessionId: "s", prompt: "x", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    store.transition(task.id, { type: "prepared_multi" });
    const turn = store.beginTurn({ taskId: task.id, stableKey: `${task.id}:1:discussing:1:0`, phase: "discussing", round: 1, participantIndex: 0, agentId: "a", snapshot: {} });
    store.completeTurn(turn.id, "cached", null);
    // Return to preparing is intentionally impossible; idempotency is asserted directly by beginTurn.
    expect(store.beginTurn({ taskId: task.id, stableKey: `${task.id}:1:discussing:1:0`, phase: "discussing", round: 1, participantIndex: 0, agentId: "a", snapshot: {} })).toMatchObject({ status: "completed", content: "cached" });
    expect(calls()).toBe(0);
  });

  it("pauses and resumes in a new attempt without repeating completed discussion turns", async () => {
    const valid = JSON.stringify({ objective: "build", summary: "safe", steps: [{ id: "1", title: "verify", description: "run tests", files: [], commands: ["bun test"], risks: [], verification: ["bun test"] }], evidence: [] });
    let releaseSecond!: () => void;
    const secondStarted = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let calls = 0;
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
    db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 'multi', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
    for (const [position, id] of ["a", "b"].entries()) db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', ?, ?, ?, 1)").run(id, JSON.stringify({ nickname: id, modelId: id }), position);
    const gateway: ModelGateway = async function* (request) {
      calls += 1;
      if (calls === 2) {
        releaseSecond();
        await new Promise<void>((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      yield { type: "delta", text: calls === 4 ? valid : `answer-${calls}` };
      yield { type: "done" };
    };
    const resolve = (id: string, snapshot: Record<string, unknown>): OrchestrationAgent => ({ id, nickname: String(snapshot.nickname), modelId: String(snapshot.modelId), role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "http://unused", apiKey: "fixture" });
    const store = new MultiTaskStore(db);
    const coordinator = new MultiAgentCoordinator(db, store, new EventStore(db), gateway, resolve);
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    const firstRun = coordinator.run(task.id);
    await secondStarted;
    coordinator.pause(task.id);
    await firstRun;
    expect(store.get(task.id)?.state).toBe("paused");
    await coordinator.resume(task.id);
    expect(store.get(task.id)).toMatchObject({ state: "awaiting_plan_approval", attemptNo: 2 });
    expect(calls).toBe(4);
  });

  it("uses only the explicit fallback order and reports the real fallback identity", async () => {
    const db = openDb(":memory:");
    const now = new Date().toISOString();
    db.query("INSERT INTO workspaces (id, canonical_path, display_path, identity_hash, label, created_at, last_opened_at) VALUES ('w', '/tmp', '/tmp', 'hash', 'tmp', ?, ?)").run(now, now);
    db.query("INSERT INTO sessions (id, title, mode, workspace_id, status, created_at, updated_at) VALUES ('s', 'multi', 'multi_agent', 'w', 'idle', ?, ?)").run(now, now);
    for (const [position, id] of ["a", "b"].entries()) db.query("INSERT INTO session_agents (session_id, agent_id, snapshot_json, position, execution_eligible) VALUES ('s', ?, ?, ?, 1)").run(id, JSON.stringify({ nickname: id.toUpperCase(), modelId: `model-${id}` }), position);
    const valid = JSON.stringify({ objective: "build", summary: "safe", steps: [{ id: "1", title: "verify", description: "test", files: [], commands: ["bun test"], risks: [], verification: ["bun test"] }], evidence: [] });
    let calls = 0;
    const gateway: ModelGateway = async function* () {
      calls += 1;
      if (calls === 1) { yield { type: "error", message: "provider_unavailable_before_accept" }; return; }
      yield { type: "delta", text: calls === 4 ? valid : `answer-${calls}` };
      yield { type: "done" };
    };
    const resolve = (id: string, snapshot: Record<string, unknown>): OrchestrationAgent => ({ id, nickname: String(snapshot.nickname), modelId: String(snapshot.modelId), role: "", systemPrompt: "", providerType: "openai_compatible", baseUrl: "http://unused", apiKey: "fixture" });
    const store = new MultiTaskStore(db);
    const coordinator = new MultiAgentCoordinator(db, store, new EventStore(db), gateway, resolve);
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a", fallbackOrderByAgent: { a: ["b"] } } });
    const events: Array<Record<string, unknown>> = [];
    await coordinator.run(task.id, (event) => { events.push(event as unknown as Record<string, unknown>); });
    expect(store.get(task.id)?.state).toBe("awaiting_plan_approval");
    expect(events.find((event) => event.type === "agent_fallback_selected")).toMatchObject({ originalAgentId: "a", fallbackAgentId: "b", nickname: "B", model: "model-b" });
    expect(store.listTurns(task.id).filter((turn) => turn.status === "completed").map((turn) => turn.agentId)).toEqual(["b", "b", "b"]);
  });

  const PLAN = JSON.stringify({ objective: "build", summary: "safe", steps: [{ id: "1", title: "edit", description: "change", files: ["src/a.ts"], commands: [], risks: [], verification: ["bun test"] }], evidence: [] });
  // 这些用例都要走讨论，显式开 round_robin（否则默认 "off" 会跳过讨论）
  const setCollab = (db: ReturnType<typeof setup>["db"], collab: Record<string, unknown>) =>
    db.query("UPDATE sessions SET collaboration_json = ? WHERE id = 's'").run(JSON.stringify({ discussionMode: "round_robin", ...collab }));

  it("Boss 开启时由 Boss 产出计划，即便配置里的 synthesizer 是别人", async () => {
    const { db, store, coordinator } = setup(["A view", "B view", PLAN]);
    setCollab(db, { collaborationMode: "agent_directed_multi_agent", boss: { enabled: true, bossAgentId: "a", allowBossExecution: false } });
    // config.synthesizerId 是 "b"，但 Boss=a 应接管综合
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "b" } });
    await coordinator.run(task.id, () => {});
    expect(store.get(task.id)?.state).toBe("awaiting_plan_approval");
    expect(store.getPlan(task.id)?.createdBy).toBe("a");
  });

  it("Boss 默认不执行：Boss 同时是执行者时直接判非法", async () => {
    const { db, store, coordinator } = setup(["A view", "B view", PLAN]);
    setCollab(db, { collaborationMode: "agent_directed_multi_agent", boss: { enabled: true, bossAgentId: "a", allowBossExecution: false } });
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "a", executionAgentId: "a" } });
    await coordinator.run(task.id, () => {});
    expect(store.get(task.id)?.state).toBe("failed");
    expect(store.get(task.id)?.terminalReason).toBe("boss_must_not_execute");
  });

  it("指定 Reviewer 批准计划：跑一次审核并附上裁决，随后交人工确认", async () => {
    const approve = JSON.stringify({ verdict: "approve", notes: "looks good" });
    const { db, store, coordinator } = setup(["A view", "B view", PLAN, approve]);
    setCollab(db, { approvalMode: "designated_reviewer", designatedReviewerId: "b" });
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "a", executionAgentId: "a" } });
    const verdicts: Array<Record<string, unknown>> = [];
    await coordinator.run(task.id, (event) => { if (event.type === "reviewer_verdict") verdicts.push(event as unknown as Record<string, unknown>); });
    expect(store.get(task.id)?.state).toBe("awaiting_plan_approval");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ reviewerId: "b", verdict: "approve", requestedRevision: false });
    expect(store.getPlan(task.id)?.version).toBe(1);
  });

  it("Reviewer 要求修改：自动重综合一版后停在人工审批", async () => {
    const reject = JSON.stringify({ verdict: "request_changes", notes: "add a test step" });
    const PLAN2 = JSON.stringify({ objective: "build v2", summary: "safer", steps: [{ id: "1", title: "test", description: "add test", files: ["src/a.ts"], commands: [], risks: [], verification: ["bun test"] }], evidence: [] });
    const { db, store, coordinator } = setup(["A view", "B view", PLAN, reject, PLAN2]);
    setCollab(db, { approvalMode: "designated_reviewer", designatedReviewerId: "b" });
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "a", executionAgentId: "a" } });
    const verdicts: Array<Record<string, unknown>> = [];
    await coordinator.run(task.id, (event) => { if (event.type === "reviewer_verdict") verdicts.push(event as unknown as Record<string, unknown>); });
    expect(verdicts[0]).toMatchObject({ verdict: "request_changes", requestedRevision: true });
    expect(store.get(task.id)?.state).toBe("awaiting_plan_approval");
    // 自动改了一版：现在应有第 2 版计划
    expect(store.getPlan(task.id)?.version).toBe(2);
    expect(store.getPlan(task.id)?.content.objective).toBe("build v2");
  });

  it("discussionMode=off 时跳过讨论，直接由综合者从 prompt 生成计划", async () => {
    // 只喂一条输出（综合计划）——若讨论没被跳过，这里会因缺讨论输出而失败
    const { db, store, coordinator } = setup([PLAN]);
    db.query("UPDATE sessions SET collaboration_json = ? WHERE id = 's'").run(JSON.stringify({ discussionMode: "off" }));
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 3, synthesizerId: "b", executionAgentId: "a" } });
    await coordinator.run(task.id, () => {});
    expect(store.get(task.id)?.state).toBe("awaiting_plan_approval");
    // 没有任何讨论轮次落库
    expect(store.listTurns(task.id).filter((turn) => turn.phase === "discussing")).toHaveLength(0);
    expect(store.getPlan(task.id)?.content.objective).toBe("build");
  });

  it("未配置协作设置的会话保持历史行为：仍然讨论", async () => {
    // collaboration_json 为空 —— 默认值 discussionMode=off 不能被当作"已关闭"
    const { store, coordinator } = setup(["A view", "B view", PLAN]);
    const task = coordinator.create({ sessionId: "s", prompt: "build", config: { speakingOrder: ["a", "b"], maxRounds: 1, synthesizerId: "b", executionAgentId: "a" } });
    await coordinator.run(task.id, () => {});
    expect(store.listTurns(task.id).filter((turn) => turn.phase === "discussing").length).toBeGreaterThan(0);
  });
});
