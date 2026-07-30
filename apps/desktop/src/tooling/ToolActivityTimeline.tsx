import type { ApprovalDecision } from "@socrates/core";
import { useState } from "react";
import PixelIcon from "../PixelIcon";
import { useT, type PendingApproval } from "../store";
import type { PublicReasoning, ToolActivity } from "./toolActivity";
import { approvalReasonKey, safeTechnicalJson } from "./toolActivity";

function formatDuration(durationMs?: number): string {
  if (durationMs === undefined) return "";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function ToolActivityRow({ activity }: { activity: ToolActivity }) {
  const t = useT();
  const duration = formatDuration(activity.durationMs);
  return (
    <details
      className={`tool-activity-row tool-activity-row--${activity.status} ${activity.readOnly && activity.status === "succeeded" ? "tool-activity-row--quiet" : ""}`}
    >
      <summary className="tool-activity-summary">
        <span className="tool-activity-icon" aria-hidden="true">
          <PixelIcon name={activity.operation === "command" ? "gear" : "folder"} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="tool-activity-verb">{t(`tool_operation_${activity.operation}`)}</span>
          <span className="tool-activity-subject" title={activity.subject}>{activity.subject}</span>
        </span>
        {duration && <span className="tool-activity-duration">{duration}</span>}
        <span className="tool-activity-status">{t(`tool_status_${activity.status}`)}</span>
        <span className="tool-activity-disclosure" aria-hidden="true">›</span>
      </summary>
      <div className="tool-activity-details">
        <div>
          <div className="tool-activity-detail-label">{t("tool_detail_request")}</div>
          <pre>{safeTechnicalJson(activity.input)}</pre>
        </div>
        {activity.output && (
          <div>
            <div className="tool-activity-detail-label">{t("tool_detail_result")}</div>
            <pre>{safeTechnicalJson(activity.output)}</pre>
          </div>
        )}
      </div>
    </details>
  );
}

export function ToolActivityTimeline({
  activities,
  showHeading = true,
}: {
  activities: ToolActivity[];
  showHeading?: boolean;
}) {
  const t = useT();
  if (!activities.length) return null;
  return (
    <section className="tool-activity-timeline" aria-label={t("tool_activity_title")}>
      {showHeading && <div className="tool-activity-heading">
        <PixelIcon name="gear" size={14} />
        <span>{t("tool_activity_title")}</span>
        <span className="pixel-chip">{activities.length}</span>
      </div>}
      {activities.map((activity) => <ToolActivityRow key={activity.id} activity={activity} />)}
    </section>
  );
}

export function PublicReasoningPanel({
  summaries,
  running,
}: {
  summaries: PublicReasoning[];
  running: boolean;
}) {
  const t = useT();
  if (!summaries.length && !running) return null;
  if (!summaries.length) {
    return (
      <div className="public-reasoning public-reasoning--running" role="status">
        <span className="thinking-pixel" aria-hidden="true" />
        {t("reasoning_working")}
      </div>
    );
  }
  return (
    <details className="public-reasoning" open={running}>
      <summary>
        {running && <span className="thinking-pixel" aria-hidden="true" />}
        {running ? t("reasoning_working") : t("reasoning_summary")}
        <span className="tool-activity-disclosure" aria-hidden="true">›</span>
      </summary>
      <div className="public-reasoning-copy">{summaries.map((summary) => summary.text).join("\n\n")}</div>
    </details>
  );
}

export function ApprovalShelf({
  approvals,
  activities,
  workspaceLabel,
  busy,
  onDecision,
}: {
  approvals: PendingApproval[];
  activities: ToolActivity[];
  workspaceLabel: string;
  busy: boolean;
  onDecision: (requestId: string, decision: ApprovalDecision) => Promise<void>;
}) {
  const t = useT();
  const [decidingId, setDecidingId] = useState<string | null>(null);
  if (!approvals.length) return null;
  const decide = (requestId: string, decision: ApprovalDecision) => {
    if (busy || decidingId) return;
    setDecidingId(requestId);
    void onDecision(requestId, decision).finally(() => setDecidingId(null));
  };
  return (
    <section className="approval-shelf" aria-label={t("approval_shelf_title")}>
      <div className="approval-shelf-heading">
        <PixelIcon name="brain" size={16} />
        <strong>{t("approval_shelf_title")}</strong>
        <span className="pixel-chip">{approvals.length}</span>
      </div>
      {approvals.map((approval) => {
        const activity = activities.find((item) => item.approvalId === approval.id);
        return (
          <article key={approval.id} className="approval-shelf-request">
            <div className="approval-shelf-request-main">
              <div className="min-w-0">
                <div className="approval-shelf-operation">
                  {activity ? t(`tool_operation_${activity.operation}`) : approval.kind}
                  <span className={`approval-risk approval-risk--${approval.risk}`}>{approval.risk}</span>
                </div>
                <div className="approval-shelf-subject">{activity?.subject ?? t("tool_target_unavailable")}</div>
                <div className="approval-shelf-meta">
                  {t("approval_scope", { workspace: workspaceLabel })}
                  {" · "}
                  {t(activity
                    ? approvalReasonKey(activity.operation, approval.risk)
                    : `approval_risk_${approval.risk}`)}
                </div>
              </div>
              <div className="approval-shelf-actions">
                <button type="button" disabled={busy || decidingId !== null} className="pixel-button pixel-button--primary" onClick={() => decide(approval.id, "allow_once")}>
                  {t("approval_allow_once")}
                </button>
                {!approval.freshHumanRequired && (
                  <button type="button" disabled={busy || decidingId !== null} className="pixel-button" onClick={() => decide(approval.id, "allow_session")}>
                    {t("approval_allow_session")}
                  </button>
                )}
                <button type="button" disabled={busy || decidingId !== null} className="pixel-button approval-deny" onClick={() => decide(approval.id, "deny")}>
                  {t("approval_deny")}
                </button>
              </div>
            </div>
            {activity && (
              <details
                className="approval-shelf-technical"
                open={activity.operation === "command" || activity.operation === "delete"}
              >
                <summary>{t("tool_detail_request")}</summary>
                <pre>{safeTechnicalJson(activity.input)}</pre>
              </details>
            )}
          </article>
        );
      })}
    </section>
  );
}
