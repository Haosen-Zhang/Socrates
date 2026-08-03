import type { NormalizedUsage, ReasoningEffort } from "@socrates/core";
import AgentAvatar from "../AgentAvatar";
import PixelIcon from "../PixelIcon";
import { useT } from "../store";
import { contextWindowUsage } from "./contextWindowUsage";

export type RoomOverviewAgent = {
  id: string;
  nickname: string;
  avatar: string;
  modelId: string;
  role?: string;
  contextWindowTokens: number | null;
  reasoningEffort: ReasoningEffort | null;
};

type UsageSummary = {
  agentId: string | null;
  current: NormalizedUsage;
  cumulative: NormalizedUsage;
  records: number;
};

const formatUsage = (value: number | null | undefined, unavailable: string) =>
  value == null ? unavailable : value.toLocaleString();

export default function RoomOverview({ agents, usage, onManageMembers, onShowTasks, taskCount }: {
  agents: RoomOverviewAgent[];
  usage: UsageSummary[];
  onManageMembers: () => void;
  onShowTasks?: () => void;
  taskCount?: number;
}) {
  const t = useT();
  const unavailable = t("usage_unavailable");
  return <div className="pixel-room-overview">
    <section className="pixel-room-overview__section" data-section="usage">
      <div className="pixel-room-overview__section-title">
        <span><PixelIcon name="general" size={17} />{t("room_overview_usage")}</span>
      </div>
      <div className="pixel-room-overview__usage-list">
        {agents.map((agent) => {
          const summary = usage.find((item) => item.agentId === agent.id);
          const context = contextWindowUsage(summary?.current.inputTokens, agent.contextWindowTokens);
          const displayPercent = context ? Math.min(Math.max(context.percent, 0), 100) : null;
          const effort = summary?.current.effort ?? agent.reasoningEffort;
          const contextTitle = context
            ? `${t("usage_context")}: ${context.inputTokens.toLocaleString()} / ${context.capacity.toLocaleString()} (${context.percent}%${context.overCapacity ? ` · ${t("usage_over_capacity")}` : ""}) · ${t("usage_cached")}: ${formatUsage(summary?.cumulative.cachedInputTokens, unavailable)} · ${t("usage_effort")}: ${effort ?? unavailable}`
            : `${t("usage_context")}: ${unavailable}`;
          const contextTooltipId = `agent-context-${agent.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          return <article key={agent.id} className="pixel-room-overview__usage-card">
            <div className="flex min-w-0 items-center gap-2">
              <AgentAvatar src={agent.avatar} label={agent.nickname} size={34} lively={false} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-bold">{agent.nickname}</div>
                <div className="truncate text-[10px] text-neutral-500">{agent.modelId}</div>
              </div>
              <div className="context-window-indicator">
                <div
                  className={`context-window-ring ${context ? "is-available" : ""}`}
                  style={displayPercent != null ? { "--context-percent": `${displayPercent}%` } as React.CSSProperties : undefined}
                  aria-label={contextTitle}
                  aria-describedby={contextTooltipId}
                  tabIndex={0}
                ><span>{displayPercent != null ? `${displayPercent}%` : "—"}</span></div>
                <div id={contextTooltipId} role="tooltip" className="context-window-tooltip">{contextTitle}</div>
              </div>
            </div>
            <dl>
              <div><dt>{t("usage_current")}</dt><dd>{formatUsage(summary?.current.totalTokens, unavailable)}</dd></div>
              <div><dt>{t("usage_total")}</dt><dd>{formatUsage(summary?.cumulative.totalTokens, unavailable)}</dd></div>
              <div><dt>{t("usage_cached")}</dt><dd>{formatUsage(summary?.cumulative.cachedInputTokens, unavailable)}</dd></div>
              <div><dt>{t("usage_effort")}</dt><dd>{effort ?? unavailable}</dd></div>
            </dl>
          </article>;
        })}
      </div>
    </section>
    <section className="pixel-room-overview__section" data-section="members">
      <div className="pixel-room-overview__section-title">
        <span><PixelIcon name="robot" size={17} />{t("room_overview_members")}</span>
        <button type="button" className="pixel-button px-2 py-1 text-[10px]" onClick={onManageMembers}>{t("manage_members")}</button>
      </div>
      <div className="pixel-room-overview__member-list">
        {agents.map((agent) => <div key={agent.id} className="pixel-room-overview__member">
          <AgentAvatar src={agent.avatar} label={agent.nickname} size={32} lively={false} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-bold">{agent.nickname}</div>
            <div className="truncate text-[10px] text-neutral-500">{agent.role || agent.modelId}</div>
          </div>
        </div>)}
      </div>
      {onShowTasks && <button type="button" className="pixel-button mt-3 w-full px-2 py-1.5 text-xs" onClick={onShowTasks}>{t("task_history", { n: taskCount ?? 0 })}</button>}
    </section>
  </div>;
}
