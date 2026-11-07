import { afterEach, expect, it } from "bun:test";
import { VerificationRequests, verificationViewPath } from "./client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it("keeps exact target identities in a verification query", () => {
  const path = verificationViewPath({ roomId: "room/one", rootTaskId: "task?two", workPackageId: "a&b" });
  const url = new URL(path, "http://fixture.invalid");
  expect(url.searchParams.get("roomId")).toBe("room/one");
  expect(url.searchParams.get("rootTaskId")).toBe("task?two");
  expect(url.searchParams.get("workPackageId")).toBe("a&b");
});

it("retries a lost verification response with the same request id, without sharing ids across targets", async () => {
  const requests = new VerificationRequests();
  const bodies: Array<{ requestId: string; target: { roomId: string } }> = [];
  let lost = true;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (lost) { lost = false; throw new Error("response lost after server commit"); }
    return Response.json({ saved: true });
  }) as unknown as typeof fetch;
  const handshake = { port: 1, token: "fixture" };
  const first = { target: { roomId: "room-a", rootTaskId: "task" } };
  await expect(requests.mutate(handshake, "/run", first)).rejects.toThrow("response lost");
  await requests.mutate(handshake, "/run", { target: { roomId: "room-b", rootTaskId: "task" } });
  await requests.mutate(handshake, "/run", first);
  expect(bodies[0]!.requestId).toBe(bodies[2]!.requestId);
  expect(bodies[1]!.requestId).not.toBe(bodies[0]!.requestId);
  await requests.mutate(handshake, "/run", first);
  expect(bodies[3]!.requestId).not.toBe(bodies[0]!.requestId);
});

it("gives a corrected request a new identity after a definite validation rejection", async () => {
  const ids: string[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    ids.push(JSON.parse(String(init?.body)).requestId);
    return Response.json({ error: "verification_plan_changed" }, { status: 409 });
  }) as unknown as typeof fetch;
  const requests = new VerificationRequests();
  for (let n = 0; n < 2; n++) await expect(requests.mutate({ port: 1, token: "fixture" }, "/run", { target: { roomId: "room", rootTaskId: "task" } })).rejects.toThrow("verification_plan_changed");
  expect(ids[0]).not.toBe(ids[1]);
});
