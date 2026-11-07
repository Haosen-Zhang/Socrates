import { afterEach, expect, it } from "bun:test";
import type { ConversationSession } from "@socrates/core";
import { useStore } from "../store";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; useStore.setState(useStore.getInitialState()); });

it("submits the bound price quote and budget and retains identity only for unchanged retries", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  useStore.setState({ ...useStore.getInitialState(), handshake: { port: 1, token: "test-only" }, currentSessionId: "room-a",
    sessions: [{ id: "room-a", kind: "cowork", archived: false }] as ConversationSession[] });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body))); throw new Error("response lost");
  }) as unknown as typeof fetch;
  const options = { quoteId: "quote-v1", maxOutputTokens: 512, budget: { mode: "soft_limit" as const, limitAtomic: "1000000000000" } };
  await useStore.getState().sendRoomCommand("task", [], "execute", undefined, "room-a", options);
  await useStore.getState().sendRoomCommand("task", [], "execute", undefined, "room-a", options);
  // Restoring the draft after a lost response triggers a new local quote.
  // The original command envelope must remain the retry authority.
  await useStore.getState().sendRoomCommand("task", [], "execute", undefined, "room-a", { ...options, quoteId: "quote-v2" });
  await useStore.getState().sendRoomCommand("task", [], "execute", undefined, "room-a", { ...options, budget: { ...options.budget, limitAtomic: "2000000000000" } });
  expect(bodies[0]).toMatchObject({ roomId: "room-a", content: "task", quoteId: "quote-v1", maxOutputTokens: 512,
    budget: { mode: "soft_limit", limitAtomic: "1000000000000" } });
  expect(bodies[0].clientRequestId).toBe(bodies[1].clientRequestId);
  expect(bodies[2].clientRequestId).toBe(bodies[1].clientRequestId);
  expect(bodies[2].quoteId).toBe("quote-v1");
  expect(bodies[3].clientRequestId).not.toBe(bodies[1].clientRequestId);
  expect((bodies[0].budget as { limitAtomic: string }).limitAtomic).toBe("1000000000000");
});

it("allows a new quote identity after the server definitively rejects a stale quote", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  useStore.setState({ ...useStore.getInitialState(), handshake: { port: 1, token: "test-only" }, currentSessionId: "room-a",
    sessions: [{ id: "room-a", kind: "cowork", archived: false }] as ConversationSession[] });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return Response.json({ error: "quote_stale" }, { status: 409 });
    throw new Error("response lost");
  }) as unknown as typeof fetch;
  await useStore.getState().sendRoomCommand("task", [], "execute", undefined, "room-a", { quoteId: "old", maxOutputTokens: 512 });
  expect(useStore.getState().pendingRoomRequests["room-a"]).toBeUndefined();
  await useStore.getState().sendRoomCommand("task", [], "execute", undefined, "room-a", { quoteId: "fresh", maxOutputTokens: 512 });
  expect(bodies[1].quoteId).toBe("fresh");
  expect(bodies[1].clientRequestId).not.toBe(bodies[0].clientRequestId);
});

it("binds explicit routing candidates and verification plans to the retry identity",async()=>{
  const bodies:Array<Record<string,unknown>>=[];
  useStore.setState({...useStore.getInitialState(),handshake:{port:1,token:"test-only"},currentSessionId:"room-a",sessions:[{id:"room-a",kind:"cowork",archived:false}] as ConversationSession[]});
  globalThis.fetch=(async(_input:RequestInfo|URL,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));throw Error("response lost");}) as unknown as typeof fetch;
  for(const candidate of ["direct:a","direct:a","team:a:b"])await useStore.getState().sendRoomCommand("task",[],"execute",undefined,"room-a",{quoteId:"quote"},"verified-plan",candidate);
  expect(bodies[0]).toMatchObject({verificationPlanId:"verified-plan",routingCandidateId:"direct:a"});
  expect(bodies[1].clientRequestId).toBe(bodies[0].clientRequestId);
  expect(bodies[2].clientRequestId).not.toBe(bodies[0].clientRequestId);
});
