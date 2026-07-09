import type { ProviderType } from "./provider";

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

/** Agent = 模型 + 角色 + 提示词（docs/03 §2.3 的 MVP 子集） */
export type Agent = {
  id: string;
  displayName: string;
  providerId: string;
  modelId: string;
  role: string;
  systemPrompt: string;
  temperature?: number;
  createdAt: string;
  updatedAt: string;
};

export type Room = {
  id: string;
  name: string;
  agentIds: string[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

/** 持久化的群聊消息；agent 消息快照名称与模型，agent 被改/删后历史仍真实 */
export type StoredMessage = {
  id: string;
  roomId: string;
  role: "user" | "agent";
  agentId?: string;
  agentName?: string;
  model?: string;
  content: string;
  createdAt: string;
  /** 编排任务产生的消息带轮次与阶段，普通聊天消息为空 */
  taskId?: string;
  round?: number;
  phase?: "discussion" | "summary";
  /** turn 职责（discuss/summarize/propose/critique/synthesize/judge），UI 显示角色徽标 */
  duty?: string;
};

/** POST /rooms/:id/messages 与 /rooms/:id/tasks 的 SSE 事件流 */
export type StreamEvent =
  | { type: "user_message"; message: StoredMessage }
  | {
      type: "turn_started";
      agentId: string;
      agentName: string;
      model: string;
      round?: number;
      phase?: "discussion" | "summary";
      duty?: string;
    }
  | { type: "delta"; text: string }
  | { type: "message_completed"; message: StoredMessage }
  | { type: "turn_failed"; agentName: string; message: string }
  | { type: "task_completed" }
  | { type: "task_cancelled" }
  | { type: "error"; message: string };

export function encodeSseEvent(e: StreamEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

/** 增量解析 SSE 字节流：返回完整事件与未完的余量 */
export function parseSseChunk(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // 非本协议的杂音行，忽略
      }
    }
  }
  return { events, rest };
}

export function historyToChatMessages(history: StoredMessage[]): ChatMessage[] {
  return history
    .filter((m) => m.content.length > 0)
    .map((m) => ({ role: m.role === "user" ? ("user" as const) : ("assistant" as const), content: m.content }));
}

/** 模型网关：sidecar 注入 AI SDK 实现，测试注入脚本化替身（docs/02 §4.5 的测试缝） */
export type GatewayRequest = {
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  system?: string;
  temperature?: number;
  messages: ChatMessage[];
  /** 任务取消时中止底层请求，不再消耗 token */
  signal?: AbortSignal;
};

export type TokenUsage = { inputTokens?: number; outputTokens?: number };

export type GatewayEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage?: TokenUsage }
  | { type: "error"; message: string };

export type ModelGateway = (req: GatewayRequest) => AsyncIterable<GatewayEvent>;
