import type { SessionMessage } from "@socrates/core";
import AgentAvatar from "./AgentAvatar";

type MessageIdentity = Pick<SessionMessage, "authorId"> & {
  authorSnapshot?: Record<string, unknown>;
};

/** Run-level identity wins; room snapshots only fill legacy missing fields. */
export function messageAuthorIdentity(
  message: MessageIdentity,
  roomSnapshot?: Record<string, unknown>,
) {
  const snapshot = { ...roomSnapshot, ...message.authorSnapshot };
  return {
    nickname:
      typeof snapshot.nickname === "string" && snapshot.nickname
        ? snapshot.nickname
        : (message.authorId ?? "Agent"),
    modelId: typeof snapshot.modelId === "string" ? snapshot.modelId : "",
    avatar:
      typeof snapshot.avatar === "string" && snapshot.avatar
        ? snapshot.avatar
        : undefined,
  };
}

export default function SessionMessageAuthor({
  message,
  roomSnapshot,
}: {
  message: MessageIdentity;
  roomSnapshot?: Record<string, unknown>;
}) {
  const author = messageAuthorIdentity(message, roomSnapshot);
  return (
    <div
      data-author-id={message.authorId ?? undefined}
      className="mb-1.5 flex items-center gap-2 text-xs text-neutral-500"
    >
      <AgentAvatar src={author.avatar} label={author.nickname} size={30} />
      <span>
        {author.nickname}
        {author.modelId ? ` · ${author.modelId}` : ""}
      </span>
    </div>
  );
}
