import type { Database } from "bun:sqlite";
import type { VerificationTarget, VerificationView, VerifyOptions } from "@socrates/core";

/** A shared seam for execution hosts; the verification service owns all evidence. */
export interface WorkVerification {
  verify(target: VerificationTarget, options?: VerifyOptions): Promise<VerificationView>;
  view(target: VerificationTarget): VerificationView;
  cancelRoot?(roomId: string, rootTaskId: string): Promise<void>;
}

export function taskVerificationTarget(db: Database, taskId: string, workPackageId?: string): VerificationTarget {
  const task = db.query<{session_id:string;config_json:string},[string]>("SELECT session_id,config_json FROM multi_tasks WHERE id=?").get(taskId);
  if (!task) throw new Error("multi_task_not_found");
  const config = JSON.parse(task.config_json) as {clientRequestId?:string};
  return {roomId:task.session_id,rootTaskId:config.clientRequestId ?? taskId,...(workPackageId ? {workPackageId} : {})};
}
