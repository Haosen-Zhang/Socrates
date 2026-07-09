import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { parseSseChunk, type ModelGateway, type StreamEvent } from "@socrates/core";
import { openDb } from "./db";
import { MemorySecrets } from "./secrets";
import { providerRoutes } from "./providers";
import { agentRoutes } from "./agents";
import { roomRoutes } from "./rooms";

function makeApp(gateway: ModelGateway): { app: Hono; db: Database } {
  const db = openDb(":memory:");
  const secrets = new MemorySecrets();
  const app = new Hono();
  app.route("/providers", providerRoutes(db, secrets));
  app.route("/agents", agentRoutes(db));
  app.route("/rooms", roomRoutes(db, secrets, gateway));
  return { app, db };
}

const echoGateway: ModelGateway = async function* (req) {
  yield { type: "delta", text: `${req.modelId}的观点` };
  yield { type: "done", usage: { inputTokens: 7, outputTokens: 3 } };
};

async function setupTwoAgentRoom(app: Hono) {
  const provider = await (
    await app.request("/providers", {
      method: "POST",
      body: JSON.stringify({ name: "DS", type: "openai_compatible", apiKey: "sk-x" }),
    })
  ).json();
  const mkAgent = async (name: string, model: string) =>
    (
      await app.request("/agents", {
        method: "POST",
        body: JSON.stringify({ displayName: name, providerId: provider.id, modelId: model }),
      })
    ).json();
  const a = await mkAgent("甲", "model-a");
  const b = await mkAgent("乙", "model-b");
  const room = await (
    await app.request("/rooms", {
      method: "POST",
      body: JSON.stringify({ name: "圆桌", agentIds: [a.id, b.id] }),
    })
  ).json();
  return { a, b, room };
}

async function postTask(app: Hono, roomId: string, body: Record<string, unknown>) {
  const res = await app.request(`/rooms/${roomId}/tasks`, { method: "POST", body: JSON.stringify(body) });
  if (!res.headers.get("content-type")?.includes("text/event-stream")) return { res, events: null };
  const { events } = parseSseChunk(await res.text());
  return { res, events };
}

describe("round robin task", () => {
  it("streams the whole discussion and persists messages with round/phase", async () => {
    const { app } = makeApp(echoGateway);
    const { a, b, room } = await setupTwoAgentRoom(app);
    const { events } = await postTask(app, room.id, {
      prompt: "讨论架构",
      speakingOrder: [a.id, b.id],
      maxRounds: 2,
      finalSummarizerId: a.id,
    });
    const types = (events as StreamEvent[]).map((e) => e.type);
    // 1 user_message + 5 turn (2轮×2 + 总结)，每 turn 有 started/delta/completed
    expect(types.filter((t) => t === "turn_started")).toHaveLength(5);
    expect(types.filter((t) => t === "message_completed")).toHaveLength(5);
    expect(types.at(-1)).toBe("task_completed");

    const history = await (await app.request(`/rooms/${room.id}/messages`)).json();
    expect(history).toHaveLength(6);
    expect(history[0].role).toBe("user");
    expect(history[1].round).toBe(1);
    expect(history[1].phase).toBe("discussion");
    expect(history[1].agentName).toBe("甲");
    expect(history[2].agentName).toBe("乙");
    const summary = history.at(-1);
    expect(summary.phase).toBe("summary");
    expect(summary.agentName).toBe("甲");
    expect(history.every((m: { taskId?: string }) => m.taskId)).toBeTrue();
  });

  it("writes turn traces with usage into the turns table", async () => {
    const { app, db } = makeApp(echoGateway);
    const { a, b, room } = await setupTwoAgentRoom(app);
    await postTask(app, room.id, {
      prompt: "讨论",
      speakingOrder: [a.id, b.id],
      maxRounds: 1,
      finalSummarizerId: b.id,
    });
    const turns = db
      .query<{ round: number; phase: string; agent_name: string; status: string; input_tokens: number; output_tokens: number }, []>(
        "SELECT round, phase, agent_name, status, input_tokens, output_tokens FROM turns ORDER BY turn_index",
      )
      .all();
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => [t.agent_name, t.phase])).toEqual([
      ["甲", "discussion"],
      ["乙", "discussion"],
      ["乙", "summary"],
    ]);
    expect(turns[0].status).toBe("completed");
    expect(turns[0].input_tokens).toBe(7);
    expect(turns[0].output_tokens).toBe(3);
    const task = db.query<{ status: string }, []>("SELECT status FROM tasks").get();
    expect(task?.status).toBe("completed");
  });

  it("failed turn marks task failed and traces the error", async () => {
    let calls = 0;
    const flaky: ModelGateway = async function* () {
      calls++;
      if (calls === 2) {
        yield { type: "error", message: "boom" };
        return;
      }
      yield { type: "delta", text: "ok" };
      yield { type: "done" };
    };
    const { app, db } = makeApp(flaky);
    const { a, b, room } = await setupTwoAgentRoom(app);
    const { events } = await postTask(app, room.id, {
      prompt: "会失败",
      speakingOrder: [a.id, b.id],
      maxRounds: 1,
      finalSummarizerId: a.id,
    });
    const types = (events as StreamEvent[]).map((e) => e.type);
    expect(types).toContain("turn_failed");
    expect(types.at(-1)).toBe("error");
    expect(db.query<{ status: string }, []>("SELECT status FROM tasks").get()?.status).toBe("failed");
    const failedTurn = db
      .query<{ status: string; error: string }, []>("SELECT status, error FROM turns WHERE status = 'failed'")
      .get();
    expect(failedTurn?.error).toBe("boom");
    // 失败的 turn 不产生消息：1 user + 1 成功 turn
    const history = await (await app.request(`/rooms/${room.id}/messages`)).json();
    expect(history).toHaveLength(2);
  });

  it("rejects invalid config with 400", async () => {
    const { app } = makeApp(echoGateway);
    const { a, room } = await setupTwoAgentRoom(app);
    const { res } = await postTask(app, room.id, { prompt: "", maxRounds: 2 });
    expect(res.status).toBe(400);
    const { res: res2 } = await postTask(app, room.id, {
      prompt: "x",
      maxRounds: 0,
      finalSummarizerId: a.id,
    });
    expect(res2.status).toBe(400);
  });

  it("uses room order and defaults when fields omitted", async () => {
    const { app, db } = makeApp(echoGateway);
    const { room } = await setupTwoAgentRoom(app);
    const { events } = await postTask(app, room.id, { prompt: "用默认配置" });
    expect((events as StreamEvent[]).at(-1)?.type).toBe("task_completed");
    const task = db
      .query<{ max_rounds: number; final_summarizer_id: string; speaking_order: string }, []>(
        "SELECT max_rounds, final_summarizer_id, speaking_order FROM tasks",
      )
      .get()!;
    expect(task.max_rounds).toBe(2);
    expect(JSON.parse(task.speaking_order)).toHaveLength(2);
  });
});
