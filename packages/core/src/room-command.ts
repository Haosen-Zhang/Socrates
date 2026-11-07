import type { RoomCollaborationSettings, RoomKind } from "./room-kind";

/** Only composer-selected, stable identities route commands. Never infer from prose. */
export type RoomMention =
  | { type: "agent"; agentId: string }
  | { type: "all" }
  | { type: "file"; refId: string };
export type RoomCommandIntent = "respond" | "discuss" | "execute";
export interface RoomCommandInput {
  roomId: string;
  clientRequestId: string;
  content: string;
  mentions: RoomMention[];
  intent: RoomCommandIntent;
  attachmentIds?: string[];
  workspaceRefIds?: string[];
  quoteId?: string;
  verificationPlanId?: string;
  routingCandidateId?: string;
  maxOutputTokens?: number;
  budget?: { mode: "strict_admission" | "soft_limit" | "tracking_only"; limitAtomic: string };
}
export interface ResolvedRoomCommand {
  kind: "direct" | "discussion" | "team";
  agentIds: string[];
}
export function resolveRoomCommand(
  room: { kind: RoomKind; primaryAgentId: string; agentIds: string[]; collaboration: RoomCollaborationSettings },
  command: Pick<RoomCommandInput, "intent" | "mentions">,
): ResolvedRoomCommand {
  if (!["respond", "discuss", "execute"].includes(command.intent)) throw new Error("invalid_command_intent");
  if (room.kind === "chat" && command.intent === "execute") throw new Error("chat_execution_forbidden");
  const selected: string[] = [];
  let all = false;
  for (const mention of command.mentions) {
    if (mention.type === "agent") {
      if (!room.agentIds.includes(mention.agentId)) throw new Error("mention_must_be_room_member");
      if (!selected.includes(mention.agentId)) selected.push(mention.agentId);
    } else if (mention.type === "all") all = true;
    else if (mention.type === "file") {
      if (room.kind === "chat") throw new Error("chat_file_mentions_forbidden");
      if (!mention.refId) throw new Error("file_reference_required");
    } else throw new Error("invalid_mention_type");
  }
  const agentIds = all || (command.intent === "discuss" && !selected.length)
    ? [...room.agentIds] : selected.length ? selected : [room.primaryAgentId];
  if (!agentIds.length) throw new Error("room_requires_at_least_one_member");
  if (all || command.intent === "discuss") return { kind: "discussion", agentIds };
  if (room.kind === "cowork" && command.intent === "execute" && room.collaboration.strategy === "team") {
    return { kind: "team", agentIds };
  }
  if (agentIds.length > 1) return { kind: "discussion", agentIds };
  return { kind: "direct", agentIds };
}
