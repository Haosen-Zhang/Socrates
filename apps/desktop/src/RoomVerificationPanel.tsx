import {useEffect,useState} from "react";
import {useStorePick} from "./selectors";
import {sidecarFetch} from "./transport";
import VerificationPanel from "./verification/VerificationPanel";
import {useT} from "./store";

/** Resolve durable command ownership even after its live SSE observer closes. */
export default function RoomVerificationPanel({roomId,taskId}:{roomId:string;taskId?:string}) {
  const {handshake,activeRoomCommandId}=useStorePick("handshake","activeRoomCommandId");
  const [target,setTarget]=useState<{roomId:string;rootTaskId:string}|null>(null);
  const [error,setError]=useState(false);
  const t=useT();
  useEffect(()=>{
    const controller=new AbortController();
    setTarget(null);setError(false);
    if(handshake)void sidecarFetch(handshake,`/room-commands/rooms/${encodeURIComponent(roomId)}`,{signal:controller.signal})
      .then(async response=>{if(!response.ok)throw Error("verification_command_read_failed");return response.json() as Promise<Array<{commandId:string;taskId?:string;kind:string}>>;})
      .then(commands=>{if(controller.signal.aborted)return;const command=taskId?commands.find(item=>item.taskId===taskId):commands.find(item=>item.kind==="direct");const rootTaskId=command?.commandId ?? taskId;if(rootTaskId)setTarget({roomId,rootTaskId});})
      .catch(()=>{if(!controller.signal.aborted)setError(true);});
    return ()=>controller.abort();
  },[roomId,taskId,handshake,activeRoomCommandId]);
  if(error)return <p role="alert" className="text-xs text-red-700">{t("verify_load_failed")}</p>;
  return target?.roomId===roomId?<VerificationPanel {...target}/>:null;
}
