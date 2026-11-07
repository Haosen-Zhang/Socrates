import { useCallback, useEffect, useRef, useState } from "react";
import type { VerificationTarget, VerificationView } from "@socrates/core";
import { useStorePick } from "../selectors";
import { VerificationRequests, verificationRequest, verificationViewPath } from "./client";
import { VerificationMutationGate, VerificationReadGuard } from "./ui-state";

export function useVerification(target: VerificationTarget | null) {
  const { handshake } = useStorePick("handshake");
  const [view, setView] = useState<VerificationView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [revision, setRevision] = useState(0);
  const requests = useRef(new VerificationRequests());
  const guard = useRef(new VerificationReadGuard());
  const mutations = useRef(new VerificationMutationGate());
  const live = useRef(true);
  const targetKey = target ? verificationViewPath(target) : "";
  const currentKey = useRef(targetKey);
  currentKey.current = targetKey;
  useEffect(() => { live.current = true; return () => { live.current = false; guard.current.invalidate(); }; }, []);
  useEffect(() => {
    setView(null); setReadError(null); setActionError(null); setLoading(Boolean(targetKey));
  }, [targetKey]);
  useEffect(() => {
    if (!targetKey || !handshake) { setLoading(false); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const load = async () => {
        const ticket = guard.current.begin();
        try {
          const value = await verificationRequest<VerificationView>(handshake, targetKey, undefined, controller.signal);
          if (active && guard.current.accepts(ticket)) { setView(value); setReadError(null); }
        } catch (cause) {
          if (active && guard.current.accepts(ticket) && !controller.signal.aborted) setReadError(cause instanceof Error ? cause.message : String(cause));
        } finally { if (active && guard.current.accepts(ticket)) setLoading(false); }
      if (active) timer = setTimeout(() => void load(), 1800);
    };
    void load();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); guard.current.invalidate(); };
  }, [handshake, targetKey, revision]);
  const refresh = useCallback(() => { setActionError(null); setRevision(value => value + 1); }, []);
  const mutate = async <T,>(path: string, body: Record<string, unknown>): Promise<T | null> => {
    if (!mutations.current.begin(path)) return null;
    const scope = currentKey.current;
    guard.current.invalidate(); setActionError(null);
    if (path === "/cancel") setCancelling(true); else setBusy(true);
    try {
      const result = await requests.current.mutate<T>(handshake, path, body);
      if (!live.current || currentKey.current !== scope) return null;
      guard.current.invalidate();
      setRevision(value => value + 1);
      return result;
    } catch (cause) {
      if (live.current && currentKey.current === scope) setActionError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      mutations.current.finish(path);
      if (live.current && currentKey.current === scope) { if (path === "/cancel") setCancelling(false); else setBusy(false); }
    }
  };
  return { view, error: actionError ?? readError, stale: Boolean(readError), loading, busy: busy || cancelling, cancelling, mutate, refresh };
}
