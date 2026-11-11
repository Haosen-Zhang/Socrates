import AgentDetailPanel from "./agent-lifecycle/AgentDetailPanel";
import { useState } from "react";
import { agentLabel, type Agent } from "@socrates/core";
import AgentAvatar from "./AgentAvatar";
import AgentEditor from "./AgentEditor";
import { useT } from "./store";
import { useStorePick } from "./selectors";
import { sfx } from "./fx";

export default function AgentsSection({onOpenRoom}:{onOpenRoom?:()=>void}) {
  const { agents, providers, removeAgent, handshake, lang } = useStorePick(
    "agents",
    "providers",
    "removeAgent", "handshake", "lang",
  );
  const t = useT();
  const [detail,setDetail]=useState<string|null>(null);
  const [editing, setEditing] = useState<Agent | "new" | null>(null);
  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="pixel-kicker">AGENT ROSTER</div>
          <h2 className="text-xl font-bold">{t("agents_title")}</h2>
          <p className="mt-1 text-sm text-neutral-500">
            {t("agents_subtitle")}
          </p>
        </div>
        <button
          className="pixel-button pixel-button--primary px-4 py-2 text-sm"
          onClick={() => setEditing("new")}
        >
          + {t("agent_create")}
        </button>
      </div>
      {agents.length === 0 ? (
        <button
          className="pixel-empty w-full p-8 text-sm text-neutral-500"
          onClick={() => setEditing("new")}
        >
          {t("agents_empty")}
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {agents.map((agent) => (
            <article key={agent.id} className="pixel-card group flex gap-4 p-4">
              <AgentAvatar
                src={agent.avatar}
                label={agent.nickname}
                size={72}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{agentLabel(agent)}</div>
                <div className="mt-1 truncate text-xs text-neutral-500">
                  {providers.find((p) => p.id === agent.providerId)?.name ??
                    t("provider_deleted")}
                </div>
                {agent.role && (
                  <div className="pixel-chip mt-3 inline-block">
                    {agent.role}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 flex-col gap-2">
                <button className="pixel-button px-2 py-1 text-xs" aria-label={`${lang==='en'?'View agent':'查看 Agent'} ${agent.nickname}`} onClick={()=>setDetail(agent.id)}>{lang==='en'?'Activity':'运行详情'}</button>
                <button
                  className="pixel-button px-2 py-1 text-xs"
                  onClick={() => setEditing(agent)}
                >
                  {t("edit")}
                </button>
                <button
                  className="pixel-button pixel-button--danger px-2 py-1 text-xs"
                  onClick={() => {
                    sfx.delete();
                    void removeAgent(agent.id);
                  }}
                >
                  {t("delete")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
      {detail&&handshake&&<AgentDetailPanel agentId={detail} handshake={handshake} onClose={()=>setDetail(null)} onOpenRoom={onOpenRoom}/>}
      {editing && (
        <AgentEditor
          agent={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {}}
        />
      )}
    </section>
  );
}
