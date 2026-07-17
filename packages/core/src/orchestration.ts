import type { ChatMessage, ModelGateway, TokenUsage } from "./chat";
import type { ProviderType } from "./provider";
import type { ReasoningEffort } from "./model-capabilities";

export type TaskMode = "round_robin" | "debate";

/** Debate 四角色（docs/04 §6.2），允许同一 Agent 兼任多角色 */
export type DebateRoles = {
  proposerId: string;
  skepticId: string;
  synthesizerId: string;
  judgeId: string;
};

export type TaskConfig = {
  prompt: string;
  mode: TaskMode;
  maxRounds: number;
  /** round_robin 专用 */
  speakingOrder: string[];
  /** round_robin 专用 */
  finalSummarizerId: string;
  /** debate 专用 */
  debate?: DebateRoles;
};

/** 引擎所需的 Agent 视图：配置 + 已解析的供应商凭证（由 sidecar 注入，core 零 IO） */
export type OrchestrationAgent = {
  id: string;
  nickname: string;
  avatar?: string;
  modelId: string;
  role: string;
  systemPrompt: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
};

export type TurnPhase = "discussion" | "summary";
export type TurnDuty = "discuss" | "summarize" | "propose" | "critique" | "synthesize" | "judge";

export type TurnSpec = {
  agentId: string;
  round: number;
  phase: TurnPhase;
  duty: TurnDuty;
};

export type CompletedTurn = {
  agentId: string;
  agentName: string;
  round: number;
  content: string;
};

type TurnMeta = TurnSpec & {
  turnIndex: number;
  agentName: string;
  agentAvatar?: string;
  model: string;
};

export type OrchestrationEvent =
  | ({ type: "turn_started" } & TurnMeta)
  | { type: "delta"; text: string }
  | ({ type: "turn_completed"; content: string; usage?: TokenUsage } & TurnMeta)
  | ({ type: "turn_failed"; message: string } & TurnMeta)
  | { type: "task_completed" }
  | { type: "task_cancelled" }
  | { type: "task_failed"; message: string };

/** turn 失败后的处置：重试当前 turn / 跳过继续 / 终止任务 */
export type TurnFailureDecision = "retry" | "skip" | "abort";

export type TaskStatus = "running" | "completed" | "failed" | "cancelled";

/** 历史任务列表条目（GET /rooms/:id/tasks），token 为该任务全部 turn 的合计 */
export type TaskSummary = {
  id: string;
  roomId: string;
  prompt: string;
  mode: TaskMode;
  status: TaskStatus;
  error?: string;
  createdAt: string;
  completedAt?: string;
  inputTokens: number;
  outputTokens: number;
};

export function validateTaskConfig(cfg: TaskConfig, roomAgentIds: string[]): string | null {
  if (!cfg.prompt.trim()) return "任务描述不能为空";
  if (!Number.isInteger(cfg.maxRounds) || cfg.maxRounds < 1 || cfg.maxRounds > 20) {
    return "轮数必须是 1-20 的整数";
  }
  if (cfg.mode === "debate") {
    if (!cfg.debate) return "Debate 模式需要指派四个角色";
    for (const [label, id] of [
      ["提案者", cfg.debate.proposerId],
      ["质疑者", cfg.debate.skepticId],
      ["综合者", cfg.debate.synthesizerId],
      ["裁决者", cfg.debate.judgeId],
    ] as const) {
      if (!roomAgentIds.includes(id)) return `${label}必须是房间成员`;
    }
    return null;
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

/**
 * 把任务配置编译成确定性 turn 序列。
 * Debate 按 docs/04 §7 推广：第 1 轮 [提案,质疑,x]，之后 [质疑,提案,x]；
 * x 在最后一轮是裁决（summary），否则是综合。maxRounds=2 时精确还原文档示例。
 */
export function buildTurnPlan(cfg: TaskConfig): TurnSpec[] {
  const plan: TurnSpec[] = [];
  if (cfg.mode === "debate") {
    const d = cfg.debate!;
    for (let r = 1; r <= cfg.maxRounds; r++) {
      const pair: Array<[string, TurnDuty]> =
        r === 1
          ? [
              [d.proposerId, "propose"],
              [d.skepticId, "critique"],
            ]
          : [
              [d.skepticId, "critique"],
              [d.proposerId, "propose"],
            ];
      for (const [agentId, duty] of pair) {
        plan.push({ agentId, round: r, phase: "discussion", duty });
      }
      if (r === cfg.maxRounds) {
        plan.push({ agentId: d.judgeId, round: r, phase: "summary", duty: "judge" });
      } else {
        plan.push({ agentId: d.synthesizerId, round: r, phase: "discussion", duty: "synthesize" });
      }
    }
    return plan;
  }
  const order = cfg.speakingOrder;
  for (let i = 0; i < cfg.maxRounds * order.length; i++) {
    plan.push({
      agentId: selectSpeaker(order, i),
      round: Math.floor(i / order.length) + 1,
      phase: "discussion",
      duty: "discuss",
    });
  }
  plan.push({
    agentId: cfg.finalSummarizerId,
    round: cfg.maxRounds,
    phase: "summary",
    duty: "summarize",
  });
  return plan;
}

/** 输出契约（docs/04 §5，纯 prompt 约定，不解析 —— ADR-0003） */
const OUTPUT_CONTRACT =
  "\n\n输出契约（用这些 Markdown 小节组织回答）：\n## Position\n本轮核心观点。\n## Evidence\n依据与引用的前文。\n## Critique\n对前文的质疑或风险。\n## Proposal\n建议方案。";

const DUTY_TEXT: Record<TurnDuty, (round: number, maxRounds: number) => string> = {
  discuss: (r, m) =>
    `本轮职责：这是多位 AI 围绕同一任务的圆桌讨论（第 ${r}/${m} 轮）。阅读任务与已有发言后给出你的观点：明确认同或反驳前文并说明理由，补充新的分析、风险或方案，不要重复已说过的内容。`,
  summarize: () =>
    "本轮职责：讨论已结束，你是最终总结者。综合全部讨论输出：最终结论、关键分歧、被采纳的建议、未解决的风险、行动计划。",
  propose: (r, m) =>
    r === 1
      ? `本轮职责：你是辩论的提案者（第 ${r}/${m} 轮）。针对任务提出完整的初始方案，说明关键决策与理由。${OUTPUT_CONTRACT}`
      : `本轮职责：你是辩论的提案者（第 ${r}/${m} 轮）。回应质疑：接受成立的批评并修正方案，反驳不成立的批评并给出依据。${OUTPUT_CONTRACT}`,
  critique: (r, m) =>
    `本轮职责：你是辩论的质疑者（第 ${r}/${m} 轮）。找出当前方案的漏洞、风险、反例与未回答的问题，逐条给出理由，不提替代方案。${OUTPUT_CONTRACT}`,
  synthesize: (r, m) =>
    `本轮职责：你是辩论的综合者（第 ${r}/${m} 轮）。梳理目前的提案与质疑：哪些批评成立、哪些已被回应，给出修正后的方案版本。${OUTPUT_CONTRACT}`,
  judge: () =>
    "本轮职责：辩论已结束，你是裁决者。综合全部提案、质疑与综合意见，输出：最终裁决与理由、关键分歧、被采纳/驳回的论点、未解决的风险、行动计划。",
};

export function buildTurnSystem(
  agent: Pick<OrchestrationAgent, "nickname" | "role" | "systemPrompt">,
  spec: Pick<TurnSpec, "duty" | "round">,
  maxRounds: number,
): string {
  const identity =
    `你是「${agent.nickname}」${agent.role ? `，角色：${agent.role}` : ""}。` +
    (agent.systemPrompt ? `\n${agent.systemPrompt}` : "");
  return `${identity}\n\n${DUTY_TEXT[spec.duty](spec.round, maxRounds)}`;
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
  /** 任务取消信号：turn 之间与流式中途都会检查，并透传给底层请求 */
  signal?: AbortSignal;
  /** turn 失败后的处置回调；缺省 abort（终止任务） */
  onTurnFailed?: (info: TurnMeta & { message: string }) => Promise<TurnFailureDecision>;
};

/**
 * 执行 turn plan：逐个 turn 调模型、流式产出事件。
 * 失败的 turn 经 onTurnFailed 决定重试/跳过/终止；取消随时生效。
 */
export async function* runTask(
  cfg: TaskConfig,
  deps: OrchestrationDeps,
): AsyncIterable<OrchestrationEvent> {
  const turns: CompletedTurn[] = [];
  const plan = buildTurnPlan(cfg);
  const cancelled = () => deps.signal?.aborted === true;

  let i = 0;
  let turnIndex = 0; // 含重试在内的执行序号，trace 用
  while (i < plan.length) {
    if (cancelled()) {
      yield { type: "task_cancelled" };
      return;
    }
    const spec = plan[i];
    const agent = deps.agents[spec.agentId];
    if (!agent) {
      yield { type: "task_failed", message: `Agent ${spec.agentId} 不存在` };
      return;
    }
    const meta: TurnMeta = {
      ...spec,
      turnIndex,
      agentName: agent.nickname,
      agentAvatar: agent.avatar,
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
        system: buildTurnSystem(agent, spec, cfg.maxRounds),
        temperature: agent.temperature,
        messages: buildDiscussionMessages(cfg.prompt, turns),
        signal: deps.signal,
      })) {
        if (cancelled()) {
          yield { type: "task_cancelled" };
          return;
        }
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
      if (cancelled()) {
        yield { type: "task_cancelled" };
        return;
      }
      failure = String(err).slice(0, 300);
    }

    turnIndex++;
    if (failure !== null) {
      yield { type: "turn_failed", message: failure, ...meta };
      const decision = (await deps.onTurnFailed?.({ ...meta, message: failure })) ?? "abort";
      if (decision === "retry") continue; // 同一 spec 重跑
      if (decision === "skip") {
        i++;
        continue;
      }
      yield { type: "task_failed", message: `「${agent.nickname}」发言失败：${failure}` };
      return;
    }
    turns.push({ agentId: spec.agentId, agentName: agent.nickname, round: spec.round, content });
    yield { type: "turn_completed", content, usage, ...meta };
    i++;
  }
  yield { type: "task_completed" };
}
