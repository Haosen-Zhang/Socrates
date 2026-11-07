import type { CostOptions } from "./ui-state";
import { requireOk, sidecarFetch, type Handshake } from "../transport";

export interface TaskQuoteView {
  id: string; roomId: string; inputHash: string; expiresAt: string; kind: string; heuristic: true;
  lowAtomic: string | null; highAtomic: string | null; currency: string;
  stages: Array<{ stage: string; lowAtomic: string | null; highAtomic: string | null; assumptions: string[] }>;
  unknowns: string[]; maxOutputTokens: number; priceSnapshotIds: string[];
}

class CostApiRejection extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "CostApiRejection"; }
}

export function isDefiniteCostRejection(error: unknown): boolean {
  return error instanceof CostApiRejection && error.status >= 400 && error.status < 500;
}

export async function costRequest<T>(handshake: Handshake | null, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!handshake) throw new Error("waiting_sidecar");
  const response = await sidecarFetch(handshake, `/cost${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    signal,
  });
  try { return await requireOk<T>(response); }
  catch (error) {
    if (!response.ok) throw new CostApiRejection(error instanceof Error ? error.message : String(error), response.status);
    throw error;
  }
}

export function commandCostBody(options?: CostOptions): CostOptions {
  return options ? { ...(options.quoteId ? { quoteId: options.quoteId } : {}),
    ...(options.budget ? { budget: { ...options.budget } } : {}),
    ...(options.maxOutputTokens ? { maxOutputTokens: options.maxOutputTokens } : {}) } : {};
}
