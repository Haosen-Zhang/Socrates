/**
 * Agent SSE Transport — Socrates Desktop
 *
 * 职责：HTTP/SSE 连接、ReadableStream 消费、重连（Phase 1 最小实现）。
 * 不包含：协议解析、业务状态迁移、UI 状态。
 */
import { parseSseChunk } from "@socrates/core";

export type Handshake = { port: number; token: string };

export async function sidecarFetch(hs: Handshake, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`http://127.0.0.1:${hs.port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${hs.token}`, ...init?.headers },
  });
  if (res.status >= 500) throw new Error(`sidecar ${path} returned ${res.status}`);
  return res;
}

export async function requireOk<T>(res: Response): Promise<T> {
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error((body.error as string) ?? `request failed (${res.status})`);
  return body as T;
}

/** SSE stream consumer — yields parsed JSON events.
 *  Supports Last-Event-ID for reconnection via optional lastEventId param. */
export async function* streamSseEvents(
  response: Response,
  lastEventId?: string,
): AsyncIterable<Record<string, unknown>> {
  if (!response.body) {
    await requireOk(response);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSseChunk(buffer);
      buffer = rest;
      for (const e of events) {
        yield e as unknown as Record<string, unknown>;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
