import { useRef, useState } from "react";
import { validateCollaborationSettings, type ConversationSession, type RoomCollaborationSettings, type RoutingPreset } from "@socrates/core";
import { useStorePick } from "../selectors";
import { useT } from "../store";
import { ErrorNotice } from "../foundation/components";
import { DetailPanel } from "../foundation/overlays";
import RoutingPolicyEditor from "./RoutingPolicyEditor";
import { applyRoutingPreset, routingPreset } from "./ui-state";

export default function RoutingPresetControls({ session, disabled = false }: { session: ConversationSession; disabled?: boolean }) {
  const { updateCollaboration, agentCapabilities } = useStorePick("updateCollaboration", "agentCapabilities");
  const t = useT();
  const [draft, setDraft] = useState<RoomCollaborationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const preset = routingPreset(session.collaboration);
  const available = agentCapabilities?.collaboration.routing === true;
  const save = async (value: RoomCollaborationSettings) => {
    if (pending.current || disabled) return;
    const problems = validateCollaborationSettings({ kind: session.kind, workspaceId: session.workspaceId, agentIds: session.agents.map(member => member.agentId) }, value);
    if (problems.length) { setError(problems[0]!); return; }
    pending.current = true; setBusy(true); setError(null);
    try { await updateCollaboration(session.id, value); setDraft(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="routing-preset-controls inline-flex flex-wrap items-center gap-1.5" data-routing-controls>
    <label className="flex items-center gap-1.5">{t("route_preset")}<select className="pixel-input px-2 py-1" aria-label={t("route_preset")} value={preset ?? "legacy"} disabled={disabled || busy || !available} onChange={event => void save(applyRoutingPreset(session.collaboration, event.target.value as RoutingPreset, session.primaryAgentId))}>
      {!preset && <option value="legacy" disabled>{t("route_legacy")}</option>}
      {(["economy", "balanced", "quality", "custom"] as const).map(option => <option key={option} value={option}>{t(`route_${option}`)}</option>)}
    </select></label>
    <button type="button" className="pixel-button px-2 py-1" onClick={() => { setDraft(session.collaboration); setError(null); }}>{t("route_advanced")}</button>
    {!draft && error && <span role="alert" style={{ color: "var(--pixel-danger)" }}>{t(error)}</span>}
    <DetailPanel drawer open={draft !== null} title={t("route_policy_title")} closeLabel={t("close")} onClose={() => { if (!busy) setDraft(null); }}>
      {draft && <div className="space-y-3 text-xs"><RoutingPolicyEditor session={session} value={draft} onChange={setDraft} disabled={disabled || busy} />
        {error && <ErrorNotice message={t(error)} />}
        <div className="flex flex-wrap gap-2"><button type="button" className="pixel-button pixel-button--primary px-3 py-1" disabled={disabled || busy || !available} onClick={() => void save(draft)}>{t("route_save")}</button><button type="button" className="pixel-button px-3 py-1" disabled={busy} onClick={() => setDraft(null)}>{t("route_discard")}</button></div>
      </div>}
    </DetailPanel>
  </div>;
}
