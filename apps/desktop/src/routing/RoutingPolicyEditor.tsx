import type { ConversationSession, RoomCollaborationSettings, RoutingPreset } from "@socrates/core";
import { DEFAULT_ROUTE_LIMITS } from "@socrates/core";
import { useState } from "react";
import { useStorePick } from "../selectors";
import { useT } from "../store";
import { ErrorNotice } from "../foundation/components";
import { applyRoutingPreset, routingPreset, toggleCallableMember, toggleExplicitMember } from "./ui-state";
import "./routing.css";

export interface RoutingPolicyEditorProps {
  session: ConversationSession;
  value: RoomCollaborationSettings;
  onChange: (next: RoomCollaborationSettings) => void;
  disabled?: boolean;
}

export default function RoutingPolicyEditor({ session, value, onChange, disabled = false }: RoutingPolicyEditorProps) {
  const t = useT();
  const { providers, agentCapabilities } = useStorePick("providers", "agentCapabilities");
  const [error, setError] = useState<string | null>(null);
  if (session.kind !== "cowork") return null;
  const routing = value.assignment.routing;
  const preset = routingPreset(value);
  const available = agentCapabilities?.collaboration.routing === true;
  const members = session.agents;
  const callable = value.assignment.callableAgentIds.length ? value.assignment.callableAgentIds : members.map(member => member.agentId);
  const providerIds = [...new Set(members.map(member => member.snapshot.providerId).filter((id): id is string => typeof id === "string"))];
  const limits = { ...DEFAULT_ROUTE_LIMITS, ...routing.limits };
  const patchRouting = (patch: Partial<typeof routing>) => onChange({ ...value, assignment: { ...value.assignment, routing: { ...routing, ...patch } } });
  const memberName = (id: string) => String(members.find(member => member.agentId === id)?.snapshot.nickname ?? id);
  const memberSelect = (label: string, selected: string | null, onPick: (id: string | null) => void) => <label>{label}<select className="pixel-input" aria-label={label} value={selected ?? ""} onChange={event => onPick(event.target.value || null)}><option value="">{t("route_use_default_member")}</option>{members.map(member => <option key={member.agentId} value={member.agentId} disabled={!member.executionEligible || !!member.unavailableReason}>{memberName(member.agentId)}</option>)}</select></label>;
  return <fieldset className="routing-policy space-y-3" disabled={disabled || !available}>
    <label className="routing-field">{t("route_preset")}<select className="pixel-input" aria-label={t("route_preset")} value={preset ?? "legacy"} onChange={event => onChange(applyRoutingPreset(value, event.target.value as RoutingPreset, session.primaryAgentId))}>
      {!preset && <option value="legacy" disabled>{t("route_legacy")}</option>}
      {(["economy", "balanced", "quality", "custom"] as const).map(option => <option key={option} value={option}>{t(`route_${option}`)}</option>)}
    </select></label>
    <p className="text-neutral-500">{t(preset ? `route_${preset}_hint` : "route_legacy_hint")}</p>
    {!available && <p>{t("routing_runtime_unavailable")}</p>}
    {preset === "custom" && <div className="routing-form-grid">
      <label>{t("execution_strategy")}<select className="pixel-input" aria-label={t("execution_strategy")} value={value.strategy} onChange={event => onChange({ ...value, strategy: event.target.value as "single" | "team" })}><option value="single">{t("direct_work")}</option><option value="team" disabled={members.length < 2}>{t("team_collaboration")}</option></select></label>
      {memberSelect(t("route_manager"), value.assignment.coordinatorAgentId, coordinatorAgentId => onChange({ ...value, assignment: { ...value.assignment, coordinatorAgentId } }))}
      {(["lightweight", "complex", "critical"] as const).map(role => <div key={role}>{memberSelect(t(`route_role_${role}`), routing[`${role}AgentId`], id => patchRouting({ [`${role}AgentId`]: id }))}</div>)}
      {memberSelect(t("route_reviewer"), value.planConfirmation.reviewerAgentId, reviewerAgentId => onChange({ ...value, planConfirmation: { ...value.planConfirmation, reviewerAgentId } }))}
    </div>}
    <section className="space-y-2"><strong>{t("route_member_pool")}</strong><p className="text-neutral-500">{t("route_pool_hint")}</p>
      <div className="flex flex-wrap gap-3">{members.map(member => <label className="flex items-center gap-1" key={member.agentId}><input type="checkbox" checked={callable.includes(member.agentId)} onChange={event => {
        try { const callableAgentIds = toggleCallableMember(value.assignment.callableAgentIds, members.map(item => item.agentId), member.agentId, event.target.checked); onChange({ ...value, assignment: { ...value.assignment, callableAgentIds } }); setError(null); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }} />{memberName(member.agentId)}</label>)}</div>
    </section>
    <section className="space-y-2"><strong>{t("route_fallbacks")}</strong><p className="text-neutral-500">{t("route_fallback_hint")}</p><div className="flex flex-wrap gap-3">{members.map(member => <label className="flex items-center gap-1" key={member.agentId}><input type="checkbox" checked={routing.fallbackAgentIds?.includes(member.agentId) ?? false} onChange={event => patchRouting({ fallbackAgentIds: toggleExplicitMember(routing.fallbackAgentIds ?? [], member.agentId, event.target.checked) })} />{memberName(member.agentId)}</label>)}</div></section>
    <section className="space-y-2"><strong>{t("route_provider_permission")}</strong><p className="text-neutral-500">{t("route_provider_hint")}</p><label className="flex items-center gap-2"><input type="checkbox" checked={routing.allowedProviderIds !== undefined} onChange={event => {
      if (event.target.checked) patchRouting({ allowedProviderIds: providerIds });
      else { const { allowedProviderIds: _removed, ...unrestricted } = routing; onChange({ ...value, assignment: { ...value.assignment, routing: unrestricted } }); }
    }} />{t("route_restrict_providers")}</label>
      {routing.allowedProviderIds !== undefined && <div className="flex flex-wrap gap-3">{providerIds.map(id => <label className="flex items-center gap-1" key={id}><input type="checkbox" checked={routing.allowedProviderIds!.includes(id)} onChange={event => patchRouting({ allowedProviderIds: toggleExplicitMember(routing.allowedProviderIds!, id, event.target.checked) })} />{providers.find(provider => provider.id === id)?.name ?? id}</label>)}</div>}
      {routing.allowedProviderIds?.length === 0 && <p className="text-amber-700">{t("route_no_provider_allowed")}</p>}
    </section>
    <div className="routing-form-grid">{(["maxRetries", "maxEscalations", "maxTotalModelCalls"] as const).map(key => <label key={key}>{t(`route_${key}`)}<input className="pixel-input" aria-label={t(`route_${key}`)} type="number" min={key === "maxTotalModelCalls" ? 1 : 0} max={key === "maxTotalModelCalls" ? 100 : 3} step={1} value={limits[key]} onChange={event => patchRouting({ limits: { ...limits, [key]: Number(event.target.value) } })} /></label>)}</div>
    <p className="text-neutral-500">{t("route_limits_hint")}</p>
    {error && <ErrorNotice message={t(error)} />}
  </fieldset>;
}
