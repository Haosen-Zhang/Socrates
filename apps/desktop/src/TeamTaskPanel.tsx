import {
  packageRecoveryKey,
  workPackageRetryInput,
} from "./workPackageRecovery";
import { useState } from "react";
import type { ConversationSession } from "@socrates/core";
import type { MultiTaskView } from "./store";
import { useT } from "./store";
import { useStorePick } from "./selectors";
import VerificationPanel from "./verification/VerificationPanel";

export default function TeamTaskPanel({
  task,
  session,
}: {
  task: MultiTaskView;
  session: ConversationSession;
}) {
  const { retryWorkPackage, assignWorkPackage, resumeMultiTask } = useStorePick(
    "retryWorkPackage",
    "assignWorkPackage",
    "resumeMultiTask",
  );
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [reviewedAttempts, setReviewedAttempts] = useState<
    Record<string, boolean>
  >({});
  const [pendingPackages, setPendingPackages] = useState<
    Record<string, boolean>
  >({});
  const packages = task.workPackages ?? [];
  const member = (id: string) =>
    String(
      session.agents.find((item) => item.agentId === id)?.snapshot.nickname ??
        id,
    );
  const perform = (op: () => Promise<void>, packageId?: string) => {
    if (packageId && pendingPackages[packageId]) return;
    if (packageId)
      setPendingPackages((current) => ({ ...current, [packageId]: true }));
    setError(null);
    void op()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => {
        if (packageId)
          setPendingPackages((current) => ({ ...current, [packageId]: false }));
      });
  };
  const summary = typeof task.summary === "object" ? task.summary : null;
  return packages.length === 0 ? null : (
    <section
      id={`team-packages-${task.id}`}
      className="pixel-card space-y-3 p-4"
      aria-label={t("work_packages")}
    >
      <h3 className="font-bold">{t("work_packages")}</h3>
      {task.state === "paused" && task.terminalReason === "verification_required" && <div className="space-y-2 text-xs">
        <p>{t("verification_required")}</p>
        <button type="button" className="pixel-button px-3 py-1" onClick={()=>perform(()=>resumeMultiTask())}>{t("continue_task")}</button>
      </div>}
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {t(error)}
        </p>
      )}
      {packages.map((item) => {
        const reviewKey = packageRecoveryKey(item);
        const needsReview = item.failureReason === "execution_outcome_unknown";
        const retryInput = workPackageRetryInput(
          item,
          reviewedAttempts[reviewKey] === true,
        );
        return (
          <article className="border-t border-neutral-200 pt-3" key={item.id}>
            <div className="flex items-center justify-between gap-3">
              <strong className="text-sm">{item.title}</strong>
              <span className="pixel-chip">{t(`package_${item.state}`)}</span>
            </div>
            <p className="my-2 text-xs text-neutral-600">{item.objective}</p>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span>{t("package_owner")}</span>
              <select
                aria-label={`${t("package_owner")}: ${item.title}`}
                className="pixel-input px-2 py-1"
                disabled={
                  task.state !== "awaiting_plan_approval" ||
                  pendingPackages[item.id]
                }
                value={item.executorAgentId}
                onChange={(event) =>
                  perform(
                    () =>
                      assignWorkPackage(task.id, item.id, event.target.value),
                    item.id,
                  )
                }
              >
                {session.agents.map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {member(agent.agentId)}
                  </option>
                ))}
              </select>
              <span>
                {t("attempt")}: {item.attemptNo}
              </span>
              {item.reviewerAgentId && (
                <span>
                  {t("package_reviewer")}: {member(item.reviewerAgentId)}
                </span>
              )}
            </div>
            {item.queueReason && (
              <p role="status" className="mt-2 text-xs text-amber-700">
                {t(
                  item.queueReason === "workspace_write_lease_busy"
                    ? "workspace_writer_queued"
                    : item.queueReason,
                )}
              </p>
            )}
            {item.dependencies.length > 0 && (
              <p className="mt-2 text-xs text-neutral-500">
                {t("package_dependencies")}:{" "}
                {item.dependencies
                  .map(
                    (id) => packages.find((dep) => dep.id === id)?.title ?? id,
                  )
                  .join(", ")}
              </p>
            )}
            {item.acceptanceCriteria.length > 0 && (
              <details className="mt-2 text-xs">
                <summary>{t("acceptance_criteria")}</summary>
                <ul className="list-disc pl-4">
                  {item.acceptanceCriteria.map((criterion, index) => (
                    <li key={index}>{criterion}</li>
                  ))}
                </ul>
              </details>
            )}
            {item.result && (
              <p className="mt-2 whitespace-pre-wrap text-xs">{item.result}</p>
            )}
            <VerificationPanel roomId={session.id} rootTaskId={task.config?.clientRequestId ?? task.id} workPackageId={item.id}/>
            {item.failureReason && (
              <p role="alert" className="mt-2 text-xs text-red-700">
                {t(item.failureReason)}
              </p>
            )}
            {needsReview && (
              <div className="mt-3 space-y-2 text-xs text-amber-800">
                <p>{t("package_outcome_review_hint")}</p>
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={reviewedAttempts[reviewKey] === true}
                    onChange={(event) =>
                      setReviewedAttempts((current) => ({
                        ...current,
                        [reviewKey]: event.target.checked,
                      }))
                    }
                  />
                  <span>{t("package_outcome_review_confirm")}</span>
                </label>
              </div>
            )}
            {["failed", "budget_stopped"].includes(item.state) && (
              <button
                className="pixel-button mt-2 px-3 py-1 text-xs"
                disabled={retryInput === null || pendingPackages[item.id]}
                onClick={() => {
                  if (retryInput)
                    perform(
                      () =>
                        retryWorkPackage(
                          task.id,
                          item.id,
                          retryInput.confirmOutcomeUnknown,
                        ),
                      item.id,
                    );
                }}
              >
                {t(item.state === "budget_stopped" ? "continue_task" : "retry")}
              </button>
            )}
          </article>
        );
      })}
      {task.summary && (
        <div className="space-y-3 border-t border-neutral-200 pt-3 text-xs">
          <strong>{t("team_result")}</strong>
          {typeof task.summary === "string" ? (
            <p className="whitespace-pre-wrap">{task.summary}</p>
          ) : (
            summary && (
              <>
                <div>
                  <h4 className="font-bold">
                    {t("package_completed")} ({summary.completed.length})
                  </h4>
                  {summary.completed.map((item) => (
                    <p key={item.id} className="mt-1 whitespace-pre-wrap">
                      {item.title} · {member(item.agentId)}
                      {item.result ? ` — ${item.result}` : ""}
                    </p>
                  ))}
                </div>
                {summary.unfinished.length > 0 && (
                  <div>
                    <h4 className="font-bold">{t("unfinished_work")}</h4>
                    {summary.unfinished.map((item) => (
                      <p key={item.id} className="mt-1">
                        {item.title} · {t(`package_${item.state}`)}
                        {item.reason ? ` — ${t(item.reason)}` : ""}
                      </p>
                    ))}
                  </div>
                )}
                {summary.verification.length > 0 && (
                  <div>
                    <h4 className="font-bold">{t("verification_results")}</h4>
                    {summary.verification.map((item) => (
                      <p
                        key={item.packageId}
                        className="mt-1 whitespace-pre-wrap"
                      >
                        {
                          packages.find((pkg) => pkg.id === item.packageId)
                            ?.title
                        }
                        :{" "}
                        {item.reviewNotes ??
                          item.result ??
                          t("verification_not_reported")}
                      </p>
                    ))}
                  </div>
                )}
                {summary.artifacts.length > 0 && (
                  <div>
                    <h4 className="font-bold">{t("reported_artifacts")}</h4>
                    {summary.artifacts.map((item, index) => (
                      <code
                        className="mr-2 inline-block"
                        key={`${item.path}-${index}`}
                      >
                        {item.path}
                      </code>
                    ))}
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
