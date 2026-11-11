import { ChatMemoryBinding } from "./project-memory/ChatMemoryBinding";
import { useEffect, useRef, useState } from "react";
import type { ConversationSession, SquadTemplate, WorkInteraction, WorkInteractionInput } from "@socrates/core";
import { useStorePick } from "./selectors";
import { useStore, useT } from "./store";
import {
  roomMentionQuery,
  retainSelectedMentions,
  type SelectedMention,
} from "./roomNavigation";
import { shouldSubmitComposerEnter } from "./composerIme";
import {reserveInteraction,type PendingInteraction} from "./work-interactions/requestIdentity";
import WillTrigger, { useTriggerPreview } from "./work-interactions/WillTrigger";
import InteractionHistory from "./work-interactions/InteractionHistory";
import { requireOk, sidecarFetch } from "./transport";
import { commandCostBody } from "./cost/client";
import PixelIcon from "./PixelIcon";
import ResizableComposer from "./composer/ResizableComposer";
import AttachmentTray from "./attachments/AttachmentTray";
import ComposerCostControls from "./cost/ComposerCostControls";
import VerificationControls from "./verification/VerificationControls";
import RoutingPresetControls from "./routing/RoutingPresetControls";
import { quoteBinding, submittedCostOptions, type BoundCostOptions } from "./cost/ui-state";

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
    draftAttachments,
    draftWorkspaceRefs,
    adaptiveStatus, handshake, lang,
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
    "draftAttachments",
    "draftWorkspaceRefs",
    "adaptiveStatus", "handshake", "lang",
  );
  const t = useT();
  const composing = useRef(false);
  const compositionEnded = useRef(Number.NEGATIVE_INFINITY);
  const draft = composerDrafts[session.id] ?? "";
  const selected = composerMentions[session.id] ?? [];
  const query = roomMentionQuery(draft);
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState<BoundCostOptions | null>(null);
  const [verificationPlanId,setVerificationPlanId]=useState<string | undefined>();
  const [routingCandidateId, setRoutingCandidateId] = useState<string | undefined>();
  const work = session.kind === "cowork";
  const en=lang==="en",tr=(zh:string,english:string)=>en?english:zh;
  const [action,setAction]=useState<WorkInteractionInput['action']>('message');
  const [delivery,setDelivery]=useState<NonNullable<WorkInteractionInput['delivery']>>('queue');
  const [submitting,setSubmitting]=useState(false),[squads,setSquads]=useState<SquadTemplate[]>([]),[interactionRevision,setInteractionRevision]=useState(0);
  const interactionRequest=useRef<PendingInteraction|null>(null);
  const interactionPath=`/room-commands/rooms/${encodeURIComponent(session.id)}/interactions`;
  useEffect(()=>{
    if(!work||!handshake||!session.workspaceId)return;
    const c=new AbortController();
    void sidecarFetch(handshake,`/squads?${new URLSearchParams({workspaceId:session.workspaceId})}`,{signal:c.signal}).then(requireOk<SquadTemplate[]>).then(rows=>{if(!c.signal.aborted)setSquads(rows.filter(s=>!s.archived));}).catch(e=>{if(!c.signal.aborted)setError(String(e));});
    return()=>c.abort();
  },[work,handshake,session.workspaceId]);
  const waitingStatus = work && adaptiveStatus && ["awaiting_approval", "awaiting_plan", "awaiting_verification", "paused_budget", "interrupted"].includes(adaptiveStatus) ? adaptiveStatus : null;
  const behavior =
    session.collaboration.strategy === "team"
      ? "team"
      : session.collaboration.discussion.enabled
        ? "discuss"
        : work
          ? "execute"
          : "respond";
  const interactionInput:WorkInteractionInput={clientRequestId:'preview',action,content:draft.trim(),mentions:retainSelectedMentions(draft.trim(),selected).map(item=>item.mention),intent:behavior==='team'?'execute':behavior,delivery,
    attachmentIds:action==='message'?draftAttachments.map(item=>item.id):[],workspaceRefIds:action==='message'?draftWorkspaceRefs.map(item=>item.id):[],
    ...(behavior!=='discuss'&&verificationPlanId?{verificationPlanId}:{}),...(routingCandidateId?{routingCandidateId}:{})};
  const {preview:triggerPreview,error:triggerError}=useTriggerPreview(handshake,interactionPath,work&&draft.trim()?interactionInput:null);
  const routeInputIdentity = JSON.stringify([session.id, session.collaboration, draft, selected, verificationPlanId, draftAttachments.map(item => item.id), draftWorkspaceRefs.map(item => item.id)]);
  useEffect(() => { setRoutingCandidateId(undefined); }, [routeInputIdentity]);
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
    if (submitting || (!work && running) || !draft.trim() || (work && !triggerPreview?.canSubmit)) return;
    const prompt = draft.trim();
    const mentions = retainSelectedMentions(prompt, selected).map(
      (item) => item.mention,
    );
    let costOptions;
    try {
      costOptions = cost && (!work || action==='message') ? submittedCostOptions(cost, quoteBinding({ roomId: session.id, content: prompt, mentions,
        intent: behavior === "team" ? "execute" : behavior,
        attachmentIds: draftAttachments.map(item => item.id), workspaceRefIds: draftWorkspaceRefs.map(item => item.id),
        ...(work && behavior !== "discuss" && verificationPlanId ? { verificationPlanId } : {}), ...(routingCandidateId ? { routingCandidateId } : {}),
        ...(cost.options.maxOutputTokens !== undefined ? { maxOutputTokens: cost.options.maxOutputTokens } : {}), ...(cost.options.budget ? { budget: cost.options.budget } : {}),
      }, session)) : undefined;
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    setComposerDraft(session.id, "");
    setComposerMentions(session.id, []);
    setError(null);
    let ok=false;
    if(work&&handshake){
      setSubmitting(true);
      const body={...interactionInput,...commandCostBody(costOptions)};
      interactionRequest.current=reserveInteraction(interactionRequest.current,body);
      try{
        await sidecarFetch(handshake,interactionPath,{method:'POST',body:JSON.stringify(interactionRequest.current.input)}).then(requireOk<WorkInteraction>);
        ok=true;interactionRequest.current=null;setInteractionRevision(n=>n+1);
        useStore.getState().clearSubmittedRoomFiles(session.id,body.attachmentIds??[],body.workspaceRefIds??[]);
        if(useStore.getState().currentSessionId===session.id)await useStore.getState().selectAgentSession(session.id);
      }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
      finally{setSubmitting(false);}
    }else{
      ok=await sendRoomCommand(prompt,mentions,behavior==='team'?'execute':behavior,undefined,session.id,costOptions,behavior!=='discuss'?verificationPlanId:undefined,behavior!=='discuss'?routingCandidateId:undefined);
    }
    if (!ok) {
      if (!(useStore.getState().composerDrafts[session.id] ?? "")) {
        setComposerDraft(session.id, prompt);
        setComposerMentions(session.id, selected);
      }
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
          {work&&squads.filter(s=>s.name.toLowerCase().includes(query.toLowerCase())).map(squad=><button type="button" role="option" aria-selected={false} key={squad.id} className="block w-full px-2 py-1 text-left text-xs hover:bg-neutral-100" onClick={()=>choose({label:`@${squad.name}`,mention:{type:'squad',squadId:squad.id}})}>@{squad.name} · Squad / Leader</button>)}
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
                  const target = useStore.getState().captureRoomTarget();
                  void addWorkspaceRef(result.relativePath, target)
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
      {!work && <ChatMemoryBinding key={session.id} roomId={session.id}/>}
      {work && action==='message' && <AttachmentTray />}
      {work && action!=='message' && (draftAttachments.length>0||draftWorkspaceRefs.length>0)&&<p className="text-xs">{tr('此操作仅保存文字；所选文件保留到下一次执行。','This action saves text only; selected files remain for the next execution.')}</p>}
      {work&&<div className="my-2 flex flex-wrap gap-2 text-xs">
        <label>{tr('消息操作','Message action')} <select className="pixel-input px-2 py-1" value={action} disabled={submitting} onChange={event=>setAction(event.target.value as typeof action)}><option value="message">{tr('发送指示','Send instruction')}</option><option value="note">{tr('仅备注，不触发','Note only, no trigger')}</option><option value="request_human_review">{tr('请求人工审核','Request human review')}</option></select></label>
        {action==='message'&&<label>{tr('交付方式','Delivery')} <select className="pixel-input px-2 py-1" value={delivery} disabled={submitting} onChange={event=>setDelivery(event.target.value as typeof delivery)}><option value="queue">{tr('排队到下一轮','Queue for the next round')}</option><option value="stop_restart">{tr('停止并重新执行','Stop and restart')}</option><option disabled value="in_run">{tr('当前运行插入不可用','In-run insertion unavailable')}</option></select></label>}
      </div>}
      {(!work||action==='message')&&<ComposerCostControls session={session} content={draft} mentions={retainSelectedMentions(draft.trim(), selected).map(item => item.mention)}
        intent={behavior === "team" ? "execute" : behavior} attachmentIds={draftAttachments.map(item => item.id)} workspaceRefIds={draftWorkspaceRefs.map(item => item.id)} disabled={submitting} onChange={setCost}
        verificationPlanId={work && behavior !== "discuss" ? verificationPlanId : undefined} routingCandidateId={routingCandidateId} onCandidateChange={setRoutingCandidateId}
        leading={work && behavior !== "discuss" ? <RoutingPresetControls key={session.id} session={session} disabled={running} /> : undefined}
        trailing={work && behavior !== "discuss" ? <VerificationControls roomId={session.id} disabled={running} onPlanChange={setVerificationPlanId} /> : undefined} />}
      {work&&<WillTrigger preview={triggerPreview} error={triggerError} loading={!!draft.trim()} en={en}/>}
      {work&&handshake&&<InteractionHistory path={interactionPath} handshake={handshake} en={en} roomId={session.id} revision={interactionRevision}/>}
      <ResizableComposer label={t("composer_resize")}>
        <span className="pixel-composer-chevron mt-1 shrink-0 self-start">
          ›
        </span>
        <textarea
          aria-label={t("task_prompt_label")}
          className="pixel-composer-input min-h-16 flex-1 resize-none bg-transparent p-2 text-sm outline-none"
          value={draft}
          disabled={submitting || (!work&&running)}
          placeholder={work && running ? tr("可补充指示，选择排队或停止后重启", "Add instructions, then queue or stop and restart") : running ? t(waitingStatus ? `route_status_${waitingStatus}` : "replying") : t("mention_placeholder")}
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
          disabled={submitting || (!work&&running) || !draft.trim() || (work&&!triggerPreview?.canSubmit)}
          aria-label={t("send")}
        >
          <PixelIcon name="send" size={18} />
        </button>
      </ResizableComposer>
    </form>
  );
}
