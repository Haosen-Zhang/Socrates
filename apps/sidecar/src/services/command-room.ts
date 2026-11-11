import {resolveRoomCommand,type WorkInteractionInput} from '@socrates/core';
import type { Database } from 'bun:sqlite';
import type { SessionStore } from '../store/session-store';
export function commandRoom(db:Database,room:NonNullable<ReturnType<SessionStore['get']>>) {
 const binding=db.query<{squad_id:string},[string]>('SELECT squad_id FROM squad_room_bindings WHERE room_id=?').get(room.id);
 const prepared=db.query<{owner_json:string},[string]>("SELECT owner_json FROM work_item_previews WHERE json_extract(preview_json,'$.executionRoomId')=?").get(room.id);
 const owner=prepared?JSON.parse(prepared.owner_json):null;
 return {...room,agentIds:room.agents.map(a=>a.agentId),squadId:binding?.squad_id ?? (owner?.ownerKind==='squad'?owner.ownerId:undefined)};
}

// Resolve queued message targets with the same frozen roster/strategy rules as command admission.
export function queuedMessageAgents(db:Database,room:NonNullable<ReturnType<SessionStore['get']>>,input:WorkInteractionInput):string[] {
 return resolveRoomCommand(commandRoom(db,room),{mentions:input.mentions,intent:input.intent??(room.kind==='chat'?'respond':'execute')}).agentIds;
}
