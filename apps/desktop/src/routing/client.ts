import type { AdaptiveWorkflowView, RouteDecision } from "@socrates/core";
import { requireOk, sidecarFetch, type Handshake } from "../transport";

export interface RoutingTaskView { decision: RouteDecision; workflow: AdaptiveWorkflowView | null }
export class RoutingRejection extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function routingRequest<T>(handshake: Handshake | null, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!handshake) throw new Error("waiting_sidecar");
  const response = await sidecarFetch(handshake, `/routing${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), signal,
  });
  try { return await requireOk<T>(response); }
  catch (error) {
    if (!response.ok) throw new RoutingRejection(error instanceof Error ? error.message : String(error), response.status);
    throw error;
  }
}

export class RoutingRequests {
  private readonly requests = new Map<string, string>();
  async mutate<T>(handshake: Handshake | null, path: string, body: Record<string, unknown>): Promise<T> {
    const signature = JSON.stringify([path, body]);
    const requestId = this.requests.get(signature) ?? crypto.randomUUID();
    this.requests.set(signature, requestId);
    try {
      const result = await routingRequest<T>(handshake, path, { ...body, requestId });
      this.requests.delete(signature);
      return result;
    } catch (error) {
      if (error instanceof RoutingRejection && error.status >= 400 && error.status < 500) this.requests.delete(signature);
      throw error;
    }
  }
}
