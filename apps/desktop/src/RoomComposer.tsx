import { useEffect, useRef, useState } from "react";
import type { ConversationSession } from "@socrates/core";
import { useStorePick } from "./selectors";
import { useStore, useT } from "./store";
import {
  roomMentionQuery,
  retainSelectedMentions,
  type SelectedMention,
} from "./roomNavigation";
import { shouldSubmitComposerEnter } from "./composerIme";
import PixelIcon from "./PixelIcon";
import ResizableComposer from "./composer/ResizableComposer";
import AttachmentTray from "./attachments/AttachmentTray";

/** Mentions are created only by explicit menu selection; plain @ text is inert. */
export default function RoomComposer({
  session,
  running,
  onOpenSettings,
}: {
  session: ConversationSession;
  running: boolean;
  onOpenSettings: () => void;
}) {
  const {
    composerDrafts,
    setComposerDraft,
    composerMentions,
    setComposerMentions,
    sendRoomCommand,
    searchWorkspacePaths,
    workspacePathResults,
    addWorkspaceRef,
    removeDraftWorkspaceRef,
    updateCollaboration,
  } = useStorePick(
    "composerDrafts",
    "setComposerDraft",
    "composerMentions",
    "setComposerMentions",
    "sendRoomCommand",
    "searchWorkspacePaths",
    "workspacePathResults",
    "addWorkspaceRef",
    "removeDraftWorkspaceRef",
    "updateCollaboration",
  );
  const t = useT();
  const composing = useRef(false);
  const compositionEnded = useRef(Number.NEGATIVE_INFINITY);
  const draft = composerDrafts[session.id] ?? "";
  const selected = composerMentions[session.id] ?? [];
  const query = roomMentionQuery(draft);
  const [error, setError] = useState<string | null>(null);
  const work = session.kind === "cowork";
  const behavior =
    session.collaboration.strategy === "team"
      ? "team"
      : session.collaboration.discussion.enabled
        ? "discuss"
        : work
          ? "execute"
          : "respond";
  useEffect(() => {
    if (work && query !== null)
      void searchWorkspacePaths(query).catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [query, work, searchWorkspacePaths]);
  const updateDraft = (text: string) => {
    setComposerDraft(session.id, text);
    setComposerMentions(session.id, retainSelectedMentions(text, selected));
  };
  const choose = (item: SelectedMention, clickedDraft = draft) => {
    const state = useStore.getState();
    const currentDraft = state.composerDrafts[session.id] ?? "";
    const currentSelected = state.composerMentions[session.id] ?? [];
    const text =
      currentDraft === clickedDraft && roomMentionQuery(currentDraft) !== null
        ? currentDraft.replace(/@[^\s]*$/u, `${item.label} `)
        : `${currentDraft.trimEnd()} ${item.label} `.trimStart();
    setComposerDraft(session.id, text);
    setComposerMentions(session.id, [
      ...currentSelected.filter(
        (entry) =>
          JSON.stringify(entry.mention) !== JSON.stringify(item.mention),
      ),
      item,
    ]);
  };
  const submit = async () => {
    if (running || !draft.trim()) return;
    const prompt = draft.trim();
    const mentions = retainSelectedMentions(prompt, selected).map(
      (item) => item.mention,
    );
    setComposerDraft(session.id, "");
    setComposerMentions(session.id, []);
    setError(null);
    const ok = await sendRoomCommand(
      prompt,
      mentions,
      behavior === "team" ? "execute" : behavior,
    );
    if (!ok) {
      setComposerDraft(session.id, prompt);
      setComposerMentions(session.id, selected);
    }
  };
  const changeBehavior = async (value: string) => {
    setError(null);
    const ids = session.agents.map((member) => member.agentId);
    const config = session.collaboration;
    try {
      await updateCollaboration(session.id, {
        ...config,
        strategy: value === "team" ? "team" : "single",
        assignment: {
          ...config.assignment,
          coordinatorAgentId:
            config.assignment.coordinatorAgentId ?? session.primaryAgentId,
          callableAgentIds: ids,
        },
        discussion: {
          ...config.discussion,
          enabled: value === "discuss",
          speakerOrder: config.discussion.speakerOrder.length
            ? config.discussion.speakerOrder
            : ids,
          summaryAgentId:
            config.discussion.summaryAgentId ?? session.primaryAgentId,
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const defaultMember = session.agents.find(
    (member) => member.agentId === session.primaryAgentId,
  );
  return (
    <form
      className="composer-dock"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-600">
        <select
          aria-label={t("response_mode")}
          className="pixel-input px-2 py-1 text-xs"
          value={behavior}
          disabled={running}
          onChange={(event) => void changeBehavior(event.target.value)}
        >
          <option value={work ? "execute" : "respond"}>
            {t(work ? "direct_work" : "direct_response")}
          </option>
          <option value="discuss" disabled={session.agents.length < 2}>
            {t("team_discussion")}
          </option>
          {work && (
            <option value="team" disabled={session.agents.length < 2}>
              {t("team_collaboration")}
            </option>
          )}
        </select>
        {(selected.some((item) => item.mention.type === "all") ||
          selected.filter((item) => item.mention.type === "agent").length >
            1) && <span className="pixel-chip">{t("team_discussion")}</span>}
        <span>
          {t("default_member")}:{" "}
          {String(defaultMember?.snapshot.nickname ?? session.primaryAgentId)}
        </span>
        <button
          type="button"
          className="pixel-button ml-auto px-2 py-1 text-xs"
          onClick={onOpenSettings}
        >
          {t("room_members_title")} · {t("settings_title")}
        </button>
      </div>
      {selected.length > 0 && (
        <div
          className="mb-2 flex flex-wrap gap-1"
          aria-label={t("message_targets")}
        >
          {selected.map((item, index) => (
            <button
              type="button"
              className="pixel-chip"
              key={`${item.label}-${index}`}
              onClick={() => {
                if (item.mention.type === "file")
                  removeDraftWorkspaceRef(item.mention.refId);
                setComposerMentions(
                  session.id,
                  selected.filter((_, i) => i !== index),
                );
                setComposerDraft(session.id, draft.replace(item.label, ""));
              }}
            >
              {item.label} ×
            </button>
          ))}
        </div>
      )}
      {query !== null && (
        <div
          role="listbox"
          aria-label={t("mention_picker")}
          className="pixel-card mb-2 max-h-48 overflow-y-auto p-2"
        >
          <div className="px-2 text-[10px] text-neutral-500">
            {t("room_members_title")}
          </div>
          {session.agents
            .filter((member) =>
              String(member.snapshot.nickname ?? member.agentId)
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((member) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                key={member.agentId} disabled={Boolean(member.unavailableReason)}
                className="block w-full px-2 py-1 text-left text-xs hover:bg-neutral-100"
                onClick={() =>
                  choose({
                    label: `@${String(member.snapshot.nickname ?? member.agentId)}`,
                    mention: { type: "agent", agentId: member.agentId },
                  })
                }
              >
                @{String(member.snapshot.nickname ?? member.agentId)} ·{" "}
                {member.unavailableReason ? t(member.unavailableReason) : String(member.snapshot.role ?? member.snapshot.modelId ?? "")}
              </button>
            ))}
          {session.agents.length > 1 && (
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="block w-full px-2 py-1 text-left text-xs hover:bg-neutral-100"
              onClick={() =>
                choose({ label: "@all", mention: { type: "all" } })
              }
            >
              @all · {t("all_opinions")}
            </button>
          )}
          {work && workspacePathResults.length > 0 && (
            <div className="mt-2 px-2 text-[10px] text-neutral-500">
              {t("workspace_files")}
            </div>
          )}
          {work &&
            workspacePathResults.slice(0, 12).map((result) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                key={result.relativePath}
                className="block w-full px-2 py-1 text-left text-xs hover:bg-neutral-100"
                onClick={() => {
                  void addWorkspaceRef(result.relativePath)
                    .then((ref) =>
                      choose({
                        label: `@${result.relativePath}`,
                        mention: { type: "file", refId: ref.id },
                      }),
                    )
                    .catch((cause) => setError(String(cause)));
                }}
              >
                ↳ {result.relativePath}
              </button>
            ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mb-2 text-xs text-red-700">
          {t(error)}
        </p>
      )}
      {work && <AttachmentTray />}
      <ResizableComposer label={t("composer_resize")}>
        <span className="pixel-composer-chevron mt-1 shrink-0 self-start">
          ›
        </span>
        <textarea
          aria-label={t("task_prompt_label")}
          className="pixel-composer-input min-h-16 flex-1 resize-none bg-transparent p-2 text-sm outline-none"
          value={draft}
          disabled={running}
          placeholder={running ? t("replying") : t("mention_placeholder")}
          onChange={(event) => updateDraft(event.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
            compositionEnded.current = Date.now();
          }}
          onKeyDown={(event) => {
            if (
              shouldSubmitComposerEnter(
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  isComposing: event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                },
                {
                  composing: composing.current,
                  lastCompositionEndAt: compositionEnded.current,
                },
              )
            ) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          className="pixel-send shrink-0"
          type="submit"
          disabled={running || !draft.trim()}
          aria-label={t("send")}
        >
          <PixelIcon name="send" size={18} />
        </button>
      </ResizableComposer>
    </form>
  );
}
