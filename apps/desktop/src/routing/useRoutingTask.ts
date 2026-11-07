import { useEffect, useRef, useState } from "react";
import { useStorePick } from "../selectors";
import { RoutingRejection, RoutingRequests, routingRequest, type RoutingTaskView } from "./client";

export function useRoutingTask(roomId: string, rootTaskId: string) {
  const { handshake } = useStorePick("handshake");
  const [value, setValue] = useState<RoutingTaskView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const requests = useRef(new RoutingRequests());
  const operations = useRef(new Set<string>());
  const generation = useRef(0);
  const live = useRef(true);
  const key = `${roomId}:${rootTaskId}`;
  const currentKey = useRef(key); currentKey.current = key;
  useEffect(() => { live.current = true; return () => { live.current = false; generation.current++; }; }, []);
  useEffect(() => { setValue(null); setReadError(null); setActionError(null); setLoading(true); }, [key]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const ticket = ++generation.current;
      try {
        const next = await routingRequest<RoutingTaskView>(handshake, `/tasks/${encodeURIComponent(rootTaskId)}`, undefined, controller.signal);
        if (next.decision.roomId !== roomId || next.workflow && next.workflow.roomId !== roomId) throw new Error("routing_target_mismatch");
        if (!controller.signal.aborted && ticket === generation.current) { setValue(next); setReadError(null); }
      } catch (cause) {
        if (!controller.signal.aborted && ticket === generation.current) {
          if (cause instanceof RoutingRejection && cause.status === 404) { setValue(null); setReadError(null); }
          else setReadError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally { if (!controller.signal.aborted && ticket === generation.current) setLoading(false); }
      if (!controller.signal.aborted) timer = setTimeout(() => void load(), 1500);
    };
    void load();
    return () => { controller.abort(); if (timer) clearTimeout(timer); generation.current++; };
  }, [handshake, roomId, rootTaskId, revision]);
  const refresh = () => { setActionError(null); setRevision(value => value + 1); };
  const mutate = async (path: string, body: Record<string, unknown> = {}) => {
    const cancel = path.endsWith("/cancel");
    const operation = cancel ? "cancel" : "mutation";
    if (operations.current.has(operation) || !cancel && operations.current.size) return;
    operations.current.add(operation); generation.current++; setActionError(null);
    if (cancel) setCancelling(true); else setBusy(true);
    const scope = currentKey.current;
    try {
      await requests.current.mutate(handshake, path, body);
      if (live.current && currentKey.current === scope) { generation.current++; setRevision(value => value + 1); }
    } catch (cause) {
      if (live.current && currentKey.current === scope) setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      operations.current.delete(operation);
      if (live.current && currentKey.current === scope) { if (cancel) setCancelling(false); else setBusy(false); }
    }
  };
  return { value, error: actionError ?? readError, stale: Boolean(readError), loading, busy: busy || cancelling, cancelling, mutate, refresh };
}
