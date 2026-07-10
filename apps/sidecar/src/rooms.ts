import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import {
  encodeSseEvent,
  historyToChatMessages,
  runTask,
  validateTaskConfig,
  type ModelGateway,
  type OrchestrationAgent,
  type ProviderType,
  type StoredMessage,
  type StreamEvent,
  type TaskConfig,
  type TurnFailureDecision,
} from "@socrates/core";
import { toAgent, type AgentRow } from "./agents";
import type { SecretStore } from "./secrets";

type RoomRow = { id: string; name: string; archived: number; created_at: string; updated_at: string };
type MessageRow = {
  id: string;
  room_id: string;
  role: "user" | "agent";
  agent_id: string | null;
  agent_name: string | null;
  agent_avatar: string | null;
  model: string | null;
  content: string;
  created_at: string;
  task_id: string | null;
  round: number | null;
  phase: "discussion" | "summary" | null;
  duty: string | null;
};
type ProviderRow = { id: string; type: ProviderType; base_url: string; api_key_ref: string };

function toMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    roomId: r.room_id,
    role: r.role,
    agentId: r.agent_id ?? undefined,
    agentName: r.agent_name ?? undefined,
    agentAvatar: r.agent_avatar ?? undefined,
    model: r.model ?? undefined,
    content: r.content,
    createdAt: r.created_at,
    taskId: r.task_id ?? undefined,
    round: r.round ?? undefined,
    phase: r.phase ?? undefined,
    duty: r.duty ?? undefined,
  };
}

/** SSE 响应：客户端断开不终止 handler —— 回复/讨论仍要完整落库，只是不再写流 */
function sseResponse(handler: (emit: (e: StreamEvent) => void) => Promise<void>): Response {
  let clientGone = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      clientGone = true;
    },
    async start(controller) {
      const emit = (e: StreamEvent) => {
        if (clientGone) return;
        try {
          controller.enqueue(new TextEncoder().encode(encodeSseEvent(e)));
        } catch {
          clientGone = true;
        }
      };
      await handler(emit);
      if (!clientGone) {
        try {
          controller.close();
        } catch {
          // 消费端已取消
        }
      }
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      // hono cors 中间件不会作用到这个手工 Response，补上跨源头
      "access-control-allow-origin": "*",
    },
  });
}

export function roomRoutes(db: Database, secrets: SecretStore, gateway: ModelGateway) {
  const app = new Hono();
  /** 运行中任务的取消把手与「失败后等用户处置」的挂起决定 */
  const taskControllers = new Map<string, AbortController>();
  const taskDecisions = new Map<string, (d: TurnFailureDecision) => void>();
  const roomById = (id: string) => db.query<RoomRow, [string]>("SELECT * FROM rooms WHERE id = ?").get(id);
  const roomAgents = (roomId: string) =>
    db
      .query<AgentRow, [string]>(
        `SELECT a.* FROM agents a JOIN room_agents ra ON ra.agent_id = a.id
         WHERE ra.room_id = ? ORDER BY ra.position`,
      )
      .all(roomId);
  const roomMessages = (roomId: string) =>
    db.query<MessageRow, [string]>("SELECT * FROM messages WHERE room_id = ? ORDER BY created_at").all(roomId);

  const insertMessage = (
    m: Omit<StoredMessage, "id" | "createdAt">,
  ): StoredMessage => {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO messages (id, room_id, role, agent_id, agent_name, agent_avatar, model, content, created_at, task_id, round, phase, duty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        m.roomId,
        m.role,
        m.agentId ?? null,
        m.agentName ?? null,
        m.agentAvatar ?? null,
        m.model ?? null,
        m.content,
        now,
        m.taskId ?? null,
        m.round ?? null,
        m.phase ?? null,
        m.duty ?? null,
      ],
    );
    return { ...m, id, createdAt: now };
  };

  /** Agent 配置 + 解析供应商凭证 → 引擎视图；供应商或 key 缺失返回错误文案 */
  const resolveOrchestrationAgent = (row: AgentRow): OrchestrationAgent | string => {
    const agent = toAgent(row);
    const provider = db
      .query<ProviderRow, [string]>("SELECT id, type, base_url, api_key_ref FROM providers WHERE id = ?")
      .get(agent.providerId);
    if (!provider) return `Agent「${agent.displayName}」引用的供应商已被删除`;
    const apiKey = secrets.get(provider.api_key_ref);
    if (!apiKey) return `Keychain 中找不到「${agent.displayName}」所用供应商的 API Key`;
    return {
      id: agent.id,
      displayName: agent.displayName,
      nickname: agent.nickname,
      avatar: agent.avatar,
      modelId: agent.modelId,
      role: agent.role,
      systemPrompt: agent.systemPrompt,
      temperature: agent.temperature,
      providerType: provider.type,
      baseUrl: provider.base_url,
      apiKey,
    };
  };

  app.get("/", (c) => {
    const rows = db.query<RoomRow, []>("SELECT * FROM rooms ORDER BY created_at").all();
    return c.json(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        agentIds: roomAgents(r.id).map((a) => a.id),
        archived: r.archived === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    );
  });

  app.put("/:id/archive", async (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    const b = await c.req.json<{ archived: boolean }>();
    db.run("UPDATE rooms SET archived = ?, updated_at = ? WHERE id = ?", [
      b.archived ? 1 : 0,
      new Date().toISOString(),
      room.id,
    ]);
    return c.json({ ok: true });
  });

  app.post("/:id/agents", async (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    const b = await c.req.json<{ agentId: string }>();
    if (!db.query("SELECT id FROM agents WHERE id = ?").get(b.agentId)) {
      return c.json({ error: "Agent 不存在" }, 400);
    }
    if (db.query("SELECT 1 FROM room_agents WHERE room_id = ? AND agent_id = ?").get(room.id, b.agentId)) {
      return c.json({ error: "Agent 已在房间中" }, 409);
    }
    const next = db
      .query<{ position: number }, [string]>("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM room_agents WHERE room_id = ?")
      .get(room.id)!;
    db.run("INSERT INTO room_agents (room_id, agent_id, position) VALUES (?, ?, ?)", [room.id, b.agentId, next.position]);
    db.run("UPDATE rooms SET updated_at = ? WHERE id = ?", [new Date().toISOString(), room.id]);
    return c.json({ ok: true }, 201);
  });

  app.post("/", async (c) => {
    const b = await c.req.json<{ name: string; agentIds: string[] }>();
    if (!b.name?.trim()) return c.json({ error: "房间名不能为空" }, 400);
    if (!Array.isArray(b.agentIds) || b.agentIds.length === 0) {
      return c.json({ error: "至少邀请一个 Agent" }, 400);
    }
    for (const aid of b.agentIds) {
      if (!db.query("SELECT id FROM agents WHERE id = ?").get(aid)) {
        return c.json({ error: "存在无效的 Agent" }, 400);
      }
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run("INSERT INTO rooms (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)", [id, b.name.trim(), now, now]);
    b.agentIds.forEach((aid, i) =>
      db.run("INSERT INTO room_agents (room_id, agent_id, position) VALUES (?, ?, ?)", [id, aid, i]),
    );
    return c.json(
      { id, name: b.name.trim(), agentIds: b.agentIds, archived: false, createdAt: now, updatedAt: now },
      201,
    );
  });

  app.delete("/:id", (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    db.run("DELETE FROM turns WHERE task_id IN (SELECT id FROM tasks WHERE room_id = ?)", [room.id]);
    db.run("DELETE FROM tasks WHERE room_id = ?", [room.id]);
    db.run("DELETE FROM messages WHERE room_id = ?", [room.id]);
    db.run("DELETE FROM room_agents WHERE room_id = ?", [room.id]);
    db.run("DELETE FROM rooms WHERE id = ?", [room.id]);
    return c.json({ ok: true });
  });

  app.get("/:id/tasks", (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    type TaskRow = {
      id: string;
      room_id: string;
      prompt: string;
      mode: "round_robin" | "debate";
      status: "running" | "completed" | "failed" | "cancelled";
      error: string | null;
      created_at: string;
      completed_at: string | null;
      input_tokens: number;
      output_tokens: number;
    };
    const rows = db
      .query<TaskRow, [string]>(
        `SELECT t.id, t.room_id, t.prompt, t.mode, t.status, t.error, t.created_at, t.completed_at,
                COALESCE(SUM(tr.input_tokens), 0) AS input_tokens,
                COALESCE(SUM(tr.output_tokens), 0) AS output_tokens
         FROM tasks t LEFT JOIN turns tr ON tr.task_id = t.id
         WHERE t.room_id = ?
         GROUP BY t.id
         ORDER BY t.created_at DESC`,
      )
      .all(room.id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        roomId: r.room_id,
        prompt: r.prompt,
        mode: r.mode,
        status: r.status,
        error: r.error ?? undefined,
        createdAt: r.created_at,
        completedAt: r.completed_at ?? undefined,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
      })),
    );
  });

  app.get("/:id/messages", (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    return c.json(roomMessages(room.id).map(toMessage));
  });

  // 单 Agent 快捷对话：取房间第一个 Agent 回复
  app.post("/:id/messages", async (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    const b = await c.req.json<{ content: string }>();
    if (!b.content?.trim()) return c.json({ error: "消息不能为空" }, 400);
    const agentRow = roomAgents(room.id)[0];
    if (!agentRow) return c.json({ error: "房间里没有 Agent" }, 400);
    const agent = resolveOrchestrationAgent(agentRow);
    if (typeof agent === "string") return c.json({ error: agent }, 400);

    const userMessage = insertMessage({ roomId: room.id, role: "user", content: b.content.trim() });
    const history = roomMessages(room.id).map(toMessage);

    return sseResponse(async (emit) => {
      emit({ type: "user_message", message: userMessage });
      emit({
        type: "turn_started",
        agentId: agent.id,
        agentName: agent.nickname ?? agent.displayName,
        agentAvatar: agent.avatar,
        model: agent.modelId,
      });
      let text = "";
      let failed = false;
      try {
        for await (const ev of gateway({
          providerType: agent.providerType,
          baseUrl: agent.baseUrl,
          apiKey: agent.apiKey,
          modelId: agent.modelId,
          system: agent.systemPrompt || undefined,
          temperature: agent.temperature,
          messages: historyToChatMessages(history),
        })) {
          if (ev.type === "delta") {
            text += ev.text;
            emit({ type: "delta", text: ev.text });
          } else if (ev.type === "error") {
            failed = true;
            emit({ type: "error", message: ev.message });
          }
        }
      } catch (err) {
        failed = true;
        emit({ type: "error", message: String(err).slice(0, 300) });
      }
      if (!failed) {
        const saved = insertMessage({
          roomId: room.id,
          role: "agent",
          agentId: agent.id,
          agentName: agent.nickname ?? agent.displayName,
          agentAvatar: agent.avatar,
          model: agent.modelId,
          content: text,
        });
        emit({ type: "message_completed", message: saved });
      }
    });
  });

  // Round Robin 编排任务（docs/04 §6.1）
  app.post("/:id/tasks", async (c) => {
    const room = roomById(c.req.param("id"));
    if (!room) return c.json({ error: "房间不存在" }, 404);
    const agentRows = roomAgents(room.id);
    const roomAgentIds = agentRows.map((a) => a.id);
    const b = await c.req.json<Partial<TaskConfig>>();
    const cfg: TaskConfig = {
      prompt: b.prompt ?? "",
      mode: b.mode ?? "round_robin",
      speakingOrder: b.speakingOrder ?? roomAgentIds,
      maxRounds: b.maxRounds ?? 2,
      finalSummarizerId: b.finalSummarizerId ?? roomAgentIds[roomAgentIds.length - 1],
      debate: b.debate,
    };
    const invalid = validateTaskConfig(cfg, roomAgentIds);
    if (invalid) return c.json({ error: invalid }, 400);

    const participantIds =
      cfg.mode === "debate"
        ? [cfg.debate!.proposerId, cfg.debate!.skepticId, cfg.debate!.synthesizerId, cfg.debate!.judgeId]
        : [...cfg.speakingOrder, cfg.finalSummarizerId];
    const agents: Record<string, OrchestrationAgent> = {};
    for (const id of new Set(participantIds)) {
      const resolved = resolveOrchestrationAgent(agentRows.find((a) => a.id === id)!);
      if (typeof resolved === "string") return c.json({ error: resolved }, 400);
      agents[id] = resolved;
    }

    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO tasks (id, room_id, prompt, mode, speaking_order, max_rounds, final_summarizer_id, debate_roles, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      [
        taskId,
        room.id,
        cfg.prompt.trim(),
        cfg.mode,
        JSON.stringify(cfg.speakingOrder),
        cfg.maxRounds,
        cfg.finalSummarizerId,
        cfg.debate ? JSON.stringify(cfg.debate) : null,
        now,
      ],
    );
    const userMessage = insertMessage({ roomId: room.id, role: "user", content: cfg.prompt.trim(), taskId });

    const finishTask = (status: "completed" | "failed" | "cancelled", error?: string) =>
      db.run("UPDATE tasks SET status = ?, error = ?, completed_at = ? WHERE id = ?", [
        status,
        error ?? null,
        new Date().toISOString(),
        taskId,
      ]);
    const traceTurn = (
      meta: {
        turnIndex: number;
        round: number;
        phase: string;
        duty: string;
        agentId: string;
        agentName: string;
        model: string;
      },
      startedAt: string,
      status: "completed" | "failed",
      usage?: { inputTokens?: number; outputTokens?: number },
      error?: string,
    ) =>
      db.run(
        `INSERT INTO turns (id, task_id, turn_index, round, phase, duty, agent_id, agent_name, model, status, input_tokens, output_tokens, error, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          taskId,
          meta.turnIndex,
          meta.round,
          meta.phase,
          meta.duty,
          meta.agentId,
          meta.agentName,
          meta.model,
          status,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          error ?? null,
          startedAt,
          new Date().toISOString(),
        ],
      );

    const controller = new AbortController();
    taskControllers.set(taskId, controller);
    /** turn 失败后挂起，等用户 POST decision；10 分钟无人处置视为终止 */
    const onTurnFailed = () =>
      new Promise<TurnFailureDecision>((resolve) => {
        const timer = setTimeout(
          () => {
            if (taskDecisions.delete(taskId)) resolve("abort");
          },
          10 * 60 * 1000,
        );
        taskDecisions.set(taskId, (d) => {
          clearTimeout(timer);
          resolve(d);
        });
      });

    return sseResponse(async (emit) => {
      emit({ type: "user_message", message: userMessage });
      let turnStartedAt = now;
      try {
      for await (const ev of runTask(cfg, { agents, gateway, signal: controller.signal, onTurnFailed })) {
        if (ev.type === "turn_started") {
          turnStartedAt = new Date().toISOString();
          emit({
            type: "turn_started",
            agentId: ev.agentId,
            agentName: ev.agentName,
            agentAvatar: ev.agentAvatar,
            model: ev.model,
            round: ev.round,
            phase: ev.phase,
            duty: ev.duty,
          });
        } else if (ev.type === "delta") {
          emit({ type: "delta", text: ev.text });
        } else if (ev.type === "turn_completed") {
          traceTurn(ev, turnStartedAt, "completed", ev.usage);
          const saved = insertMessage({
            roomId: room.id,
            role: "agent",
            agentId: ev.agentId,
            agentName: ev.agentName,
            agentAvatar: ev.agentAvatar,
            model: ev.model,
            content: ev.content,
            taskId,
            round: ev.round,
            phase: ev.phase,
            duty: ev.duty,
          });
          emit({ type: "message_completed", message: saved });
        } else if (ev.type === "turn_failed") {
          traceTurn(ev, turnStartedAt, "failed", undefined, ev.message);
          emit({ type: "turn_failed", agentName: ev.agentName, message: ev.message });
        } else if (ev.type === "task_completed") {
          finishTask("completed");
          emit({ type: "task_completed" });
        } else if (ev.type === "task_cancelled") {
          finishTask("cancelled");
          emit({ type: "task_cancelled" });
        } else {
          finishTask("failed", ev.message);
          emit({ type: "error", message: ev.message });
        }
      }
      } finally {
        taskControllers.delete(taskId);
        taskDecisions.delete(taskId);
      }
    });
  });

  app.post("/:id/tasks/:taskId/cancel", (c) => {
    const controller = taskControllers.get(c.req.param("taskId"));
    if (!controller) return c.json({ error: "任务不存在或已结束" }, 404);
    controller.abort();
    // 若正挂在「等处置」上，取消视为终止
    taskDecisions.get(c.req.param("taskId"))?.("abort");
    return c.json({ ok: true });
  });

  app.post("/:id/tasks/:taskId/decision", async (c) => {
    const b = await c.req.json<{ action: TurnFailureDecision }>();
    if (!["retry", "skip", "abort"].includes(b.action)) return c.json({ error: "无效的处置" }, 400);
    const resolve = taskDecisions.get(c.req.param("taskId"));
    if (!resolve) return c.json({ error: "没有等待处置的失败 turn" }, 404);
    taskDecisions.delete(c.req.param("taskId"));
    resolve(b.action);
    return c.json({ ok: true });
  });

  return app;
}
