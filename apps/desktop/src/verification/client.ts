import type { VerificationTarget } from "@socrates/core";
import { requireOk, sidecarFetch, type Handshake } from "../transport";

class VerificationRejection extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function verificationViewPath(target: VerificationTarget): string {
  const query = new URLSearchParams({ roomId: target.roomId, rootTaskId: target.rootTaskId });
  if (target.workPackageId) query.set("workPackageId", target.workPackageId);
  return `/view?${query}`;
}

export async function verificationRequest<T>(handshake: Handshake | null, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!handshake) throw new Error("waiting_sidecar");
  const response = await sidecarFetch(handshake, `/verification${path}`, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), signal,
  });
  try { return await requireOk<T>(response); }
  catch (error) {
    if (!response.ok) throw new VerificationRejection(error instanceof Error ? error.message : String(error), response.status);
    throw error;
  }
}

/** A response can be lost after commit; retry that exact operation id until resolved. */
export class VerificationRequests {
  private readonly pending = new Map<string, string>();
  async mutate<T>(handshake: Handshake | null, path: string, body: Record<string, unknown>): Promise<T> {
    const signature = JSON.stringify([path, body]);
    const requestId = this.pending.get(signature) ?? crypto.randomUUID();
    this.pending.set(signature, requestId);
    try {
      const result = await verificationRequest<T>(handshake, path, { ...body, requestId });
      this.pending.delete(signature);
      return result;
    } catch (error) {
      if (error instanceof VerificationRejection && error.status >= 400 && error.status < 500) this.pending.delete(signature);
      throw error;
    }
  }
}
