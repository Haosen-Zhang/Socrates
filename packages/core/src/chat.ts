import type { ProviderType } from "./provider";
import type { ModelCapabilities, ReasoningEffort } from "./model-capabilities";

export type ChatRole = "system" | "user" | "assistant";
export type ChatMessage = { role: ChatRole; content: string };

export const AGENT_AVATARS = [
  "/avatars/robot-archivist.webp",
  "/avatars/cyber-fox.webp",
  "/avatars/owl-engineer.webp",
  "/avatars/axolotl-mechanic.webp",
  "/avatars/slime-alchemist.webp",
  "/avatars/cat-astronaut.webp",
] as const;

const AGENT_NICKNAMES = [
  "青铜档案员",
  "紫镜狐狸",
  "蓝羽工程师",
  "珊瑚修理匠",
  "薄荷炼金师",
  "星港领航员",
  "月面记录官",
  "霓虹侦察兵",
  "齿轮观察员",
  "琥珀质疑者",
  "电波整理师",
  "像素裁决官",
] as const;

export type AgentIdentity = { nickname: string; avatar: (typeof AGENT_AVATARS)[number] };

export const MAX_AGENT_AVATAR_BYTES = 2 * 1024 * 1024;
export const AGENT_AVATAR_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

function identityAt(index: number): AgentIdentity {
  const safe = Math.abs(index) % AGENT_NICKNAMES.length;
  return { nickname: AGENT_NICKNAMES[safe], avatar: AGENT_AVATARS[safe % AGENT_AVATARS.length] };
}

export function randomAgentIdentity(random: () => number = Math.random): AgentIdentity {
  return identityAt(Math.floor(random() * AGENT_NICKNAMES.length));
}

/** 昵称比较键：兼容全角字符、大小写和用户无意输入的重复空白。 */
export function normalizeAgentNickname(nickname: string): string {
  return nickname.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** 随机身份必须避开现有昵称；内置名字用尽后为随机基名追加最小可用序号。 */
export function randomUniqueAgentIdentity(
  existingNicknames: Iterable<string>,
  random: () => number = Math.random,
): AgentIdentity {
  const used = new Set(Array.from(existingNicknames, normalizeAgentNickname));
  const start = Math.floor(random() * AGENT_NICKNAMES.length);
  for (let offset = 0; offset < AGENT_NICKNAMES.length; offset += 1) {
    const candidate = identityAt(start + offset);
    if (!used.has(normalizeAgentNickname(candidate.nickname))) return candidate;
  }

  const base = identityAt(start);
  for (let suffix = 2; ; suffix += 1) {
    const nickname = `${base.nickname} ${suffix}`;
    if (!used.has(normalizeAgentNickname(nickname))) return { ...base, nickname };
  }
}

/** 头像仅接受内置资源或有限大小的常见光栅图片 data URL；不接受可执行 SVG。 */
export function isAgentAvatarSource(value: string): boolean {
  if (AGENT_AVATARS.includes(value as (typeof AGENT_AVATARS)[number])) return true;
  const match = /^data:image\/(?:png|jpe?g|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || match[1].length === 0 || match[1].length % 4 !== 0) return false;
  const padding = match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0;
  const decodedBytes = (match[1].length * 3) / 4 - padding;
  return decodedBytes > 0 && decodedBytes <= MAX_AGENT_AVATAR_BYTES;
}

/** 老数据没有 persona 字段时，用 id 得到稳定且无需落库的身份。 */
export function agentIdentityFromSeed(seed: string): AgentIdentity {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return identityAt(hash);
}

export function agentLabel(agent: Pick<Agent, "nickname" | "modelId">): string {
  return `${agent.nickname} (${agent.modelId})`;
}

/** Agent = 模型 + 角色 + 提示词（docs/03 §2.3 的 MVP 子集） */
export type Agent = {
  id: string;
  nickname: string;
  avatar: string;
  providerId: string;
  modelId: string;
  role: string;
  systemPrompt: string;
  temperature?: number;
  modelCapabilities?: ModelCapabilities;
  contextWindow?: import("./model-capabilities").ContextWindowResolution;
  reasoningEffort?: ReasoningEffort;
  createdAt: string;
  updatedAt: string;
};

export type Room = {
  id: string;
  name: string;
  workspaceId: string | null;
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
  agentAvatar?: string;
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
      agentAvatar?: string;
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

/** 增量解析 SSE 字节流：返回完整事件（含可选 _sseId）与未完的余量 */
export function parseSseChunk(buffer: string): { events: (StreamEvent & { _sseId?: string })[]; rest: string } {
  const events: (StreamEvent & { _sseId?: string })[] = [];
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let sseId: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("id: ")) {
        sseId = line.slice(4).trim();
        continue;
      }
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6)) as StreamEvent & { _sseId?: string };
        event._sseId = sseId;
        events.push(event);
        sseId = undefined; // consume once per data line
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
  reasoningEffort?: ReasoningEffort;
  messages: ChatMessage[];
  /** 任务取消时中止底层请求，不再消耗 token */
  signal?: AbortSignal;
};

export type TokenUsage = {
  inputTokens?: number; outputTokens?: number; totalTokens?: number;
  cachedInputTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number;
};

export type GatewayEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage?: TokenUsage }
  | { type: "error"; message: string };

export type ModelGateway = (req: GatewayRequest) => AsyncIterable<GatewayEvent>;
