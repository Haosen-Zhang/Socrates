import type { Database } from 'bun:sqlite';
/** Prepared execution rooms accept new work only through their owning WorkItem. */
export function assertWorkItemAdmission(db:Database,roomId:string,workItemRunId?:string):void {
 const prepared=db.query("SELECT id FROM work_item_previews WHERE json_extract(preview_json,'$.executionRoomId')=? LIMIT 1").get(roomId);
 if(prepared&&(!workItemRunId||!db.query('SELECT id FROM work_item_runs WHERE id=? AND execution_room_id=?').get(workItemRunId,roomId)))throw new Error('work_item_start_required');
}
