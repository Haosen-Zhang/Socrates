import type { ChatMessage, ModelGateway, TokenUsage } from "./chat";
import type { ProviderType } from "./provider";

/** Round Robin 任务配置（docs/04 §6.1；Debate 在 MVP-5 加入） */
export type TaskConfig = {
  prompt: string;
  speakingOrder: string[];
  maxRounds: number;
  finalSummarizerId: string;
};

/** 引擎所需的 Agent 视图：配置 + 已解析的供应商凭证（由 sidecar 注入，core 零 IO） */
export type OrchestrationAgent = {
  id: string;
  displayName: string;
  modelId: string;
  role: string;
  systemPrompt: string;
  temperature?: number;
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
};

export type TurnPhase = "discussion" | "summary";

export type CompletedTurn = {
  agentId: string;
  agentName: string;
  round: number;
  content: string;
};

type TurnMeta = {
  turnIndex: number;
  round: number;
  phase: TurnPhase;
  agentId: string;
  agentName: string;
  model: string;
};

export type OrchestrationEvent =
  | ({ type: "turn_started" } & TurnMeta)
  | { type: "delta"; text: string }
  | ({ type: "turn_completed"; content: string; usage?: TokenUsage } & TurnMeta)
  | ({ type: "turn_failed"; message: string } & TurnMeta)
  | { type: "task_completed" }
  | { type: "task_failed"; message: string };

export function validateTaskConfig(cfg: TaskConfig, roomAgentIds: string[]): string | null {
  if (!cfg.prompt.trim()) return "任务描述不能为空";
  if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 1 || cfg.maxRounds > 20) {
    return "轮数必须是 1-20 的整数";
  }
  if (cfg.speakingOrder.length === 0) return "发言顺序不能为空";
  for (const id of cfg.speakingOrder) {
    if (!roomAgentIds.includes(id)) return "发言顺序里有不在房间中的 Agent";
  }
  if (!roomAgentIds.includes(cfg.finalSummarizerId)) return "最终总结者必须是房间成员";
  return null;
}

/** docs/04 §7：speaker = order[turnIndex % n] */
export function selectSpeaker(order: string[], turnIndex: number): string {
  return order[turnIndex % order.length];
}

export function buildTurnSystem(
  agent: Pick<OrchestrationAgent, "displayName" | "role" | "systemPrompt">,
  phase: TurnPhase,
  round: number,
  maxRounds: number,
): string {
  const identity =
    `你是「${agent.displayName}」${agent.role ? `，角色：${agent.role}` : ""}。` +
    (agent.systemPrompt ? `\n${agent.systemPrompt}` : "");
  const duty =
    phase === "summary"
      ? "\n\n本轮职责：讨论已结束，你是最终总结者。综合全部讨论输出：最终结论、关键分歧、被采纳的建议、未解决的风险、行动计划。"
      : `\n\n本轮职责：这是多位 AI 围绕同一任务的圆桌讨论（第 ${round}/${maxRounds} 轮）。阅读任务与已有发言后给出你的观点：明确认同或反驳前文并说明理由，补充新的分析、风险或方案，不要重复已说过的内容。`;
  return identity + duty;
}

/**
 * 全量历史进上下文（ADR-0003）。整场讨论合成单条 user 消息，
 * 避免部分供应商对连续同角色消息的限制。
 */
export function buildDiscussionMessages(prompt: string, turns: CompletedTurn[]): ChatMessage[] {
  let content = `任务：\n${prompt}`;
  if (turns.length > 0) {
    content += "\n\n=== 已有讨论 ===";
    for (const t of turns) {
      content += `\n\n【${t.agentName} · 第${t.round}轮】\n${t.content}`;
    }
  }
  return [{ role: "user", content }];
}

export type OrchestrationDeps = {
  agents: Record<string, OrchestrationAgent>;
  gateway: ModelGateway;
};

/**
 * Round Robin 编排循环：maxRounds × order.length 个讨论 turn，
 * 然后 finalSummarizer 总结。turn 失败即终止任务（重试/跳过在 MVP-6）。
 */
export async function* runRoundRobin(
  cfg: TaskConfig,
  deps: OrchestrationDeps,
): AsyncIterable<OrchestrationEvent> {
  const order = cfg.speakingOrder;
  const totalDiscussionTurns = cfg.maxRounds * order.length;
  const turns: CompletedTurn[] = [];

  for (let turnIndex = 0; turnIndex <= totalDiscussionTurns; turnIndex++) {
    const phase: TurnPhase = turnIndex < totalDiscussionTurns ? "discussion" : "summary";
    const round = phase === "summary" ? cfg.maxRounds : Math.floor(turnIndex / order.length) + 1;
    const agentId = phase === "summary" ? cfg.finalSummarizerId : selectSpeaker(order, turnIndex);
    const agent = deps.agents[agentId];
    if (!agent) {
      yield { type: "task_failed", message: `Agent ${agentId} 不存在` };
      return;
    }
    const meta: TurnMeta = {
      turnIndex,
      round,
      phase,
      agentId,
      agentName: agent.displayName,
      model: agent.modelId,
    };
    yield { type: "turn_started", ...meta };

    let content = "";
    let usage: TokenUsage | undefined;
    let failure: string | null = null;
    try {
      for await (const ev of deps.gateway({
        providerType: agent.providerType,
        baseUrl: agent.baseUrl,
        apiKey: agent.apiKey,
        modelId: agent.modelId,
        system: buildTurnSystem(agent, phase, round, cfg.maxRounds),
        temperature: agent.temperature,
        messages: buildDiscussionMessages(cfg.prompt, turns),
      })) {
        if (ev.type === "delta") {
          content += ev.text;
          yield { type: "delta", text: ev.text };
        } else if (ev.type === "done") {
          usage = ev.usage;
        } else {
          failure = ev.message;
          break;
        }
      }
    } catch (err) {
      failure = String(err).slice(0, 300);
    }

    if (failure !== null) {
      yield { type: "turn_failed", message: failure, ...meta };
      yield { type: "task_failed", message: `「${agent.displayName}」发言失败：${failure}` };
      return;
    }
    turns.push({ agentId, agentName: agent.displayName, round, content });
    yield { type: "turn_completed", content, usage, ...meta };
  }
  yield { type: "task_completed" };
}
