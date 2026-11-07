import { afterEach, expect, it } from "bun:test";
import { RoutingRequests } from "./client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("keeps a lost approval response idempotent and separates other approvals and cancellation", async () => {
  const requests = new RoutingRequests();
  const received: Array<{ requestId: string; decision?: string }> = [];
  let lost = true;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    received.push(JSON.parse(String(init?.body)));
    if (lost) { lost = false; throw Error("lost after commit"); }
    return Response.json({ saved: true });
  }) as unknown as typeof fetch;
  const handshake = { port: 1, token: "fixture" };
  await expect(requests.mutate(handshake, "/approvals/a/decision", { decision: "allow" })).rejects.toThrow("lost after commit");
  await requests.mutate(handshake, "/tasks/task/cancel", {});
  await requests.mutate(handshake, "/approvals/b/decision", { decision: "deny" });
  await requests.mutate(handshake, "/approvals/a/decision", { decision: "allow" });
  expect(received[0]!.requestId).toBe(received[3]!.requestId);
  expect(new Set(received.map(item => item.requestId)).size).toBe(3);
  expect(received[2]!.decision).toBe("deny");
});

it("uses a new request identity after a definite server rejection", async () => {
  const ids: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    ids.push(JSON.parse(String(init?.body)).requestId);
    return Response.json({ error: "adaptive_approval_not_pending" }, { status: 409 });
  }) as unknown as typeof fetch;
  const requests = new RoutingRequests();
  for (let index = 0; index < 2; index++) await expect(requests.mutate({ port: 1, token: "fixture" }, "/approvals/a/decision", { decision: "allow" })).rejects.toThrow("adaptive_approval_not_pending");
  expect(ids[0]).not.toBe(ids[1]);
});
