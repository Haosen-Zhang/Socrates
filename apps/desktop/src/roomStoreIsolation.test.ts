import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConversationSession } from "@socrates/core";
import { mergeSessionMessages, useStore } from "./store";

const originalFetch = globalThis.fetch;
const sessions = ["a", "b"].map((id) => ({
  id,
  kind: "cowork",
  workspaceId: `w-${id}`,
  collaboration: { strategy: "single" },
})) as unknown as ConversationSession[];
let route: (url: string) => Response | Promise<Response>;
const json = (body: unknown) => Response.json(body);
beforeEach(() => {
  useStore.setState({
    ...useStore.getInitialState(),
    handshake: { port: 1, token: "test" },
    sessions,
    workspaces: [{ id: "w-a" }, { id: "w-b" }] as never,
  });
  route = () => json([]);
  globalThis.fetch = ((input: RequestInfo | URL) =>
    route(String(input))) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  useStore.setState(useStore.getInitialState());
});

describe("room-scoped store projections", () => {
  it("late session messages cannot navigate back or overwrite another room", async () => {
    let release!: (value: Response) => void;
    route = (url) =>
      url.includes("/sessions/a/messages")
        ? new Promise((resolve) => {
            release = resolve;
          })
        : json([]);
    const loadingA = useStore.getState().selectAgentSession("a");
    await useStore.getState().selectAgentSession("b");
    release(json([{ id: "a-message", sessionId: "a" }]));
    await loadingA;
    expect(useStore.getState().currentSessionId).toBe("b");
    expect(useStore.getState().sessionMessages).toEqual([]);
    expect(useStore.getState().roomProjections.a.sessionMessages[0]?.id).toBe(
      "a-message",
    );
  });
  it("keeps active run ownership and composer drafts with the owning room", async () => {
    await useStore.getState().selectAgentSession("a");
    useStore.setState({
      agentRunning: true,
      activeAgentRunId: "run-a",
      agentStreamText: "A stream",
      pendingApprovals: [
        {
          id: "approval-a",
          subjectId: "op",
          kind: "tool",
          risk: "low",
          freshHumanRequired: false,
          status: "pending",
        },
      ],
    });
    useStore.getState().setComposerDraft("a", "draft A");
    useStore.getState().setComposerDraft("b", "draft B");
    await useStore.getState().selectAgentSession("b");
    expect(useStore.getState().agentRunning).toBe(false);
    expect(useStore.getState().activeAgentRunId).toBeNull();
    expect(useStore.getState().pendingApprovals).toEqual([]);
    expect(useStore.getState().agentStreamText).toBe("");
    expect(useStore.getState().roomProjections.a.activeAgentRunId).toBe(
      "run-a",
    );
    await useStore.getState().selectAgentSession("a");
    expect(useStore.getState().activeAgentRunId).toBe("run-a");
    expect(useStore.getState().agentStreamText).toBe("A stream");
    expect(useStore.getState().composerDrafts).toEqual({
      a: "draft A",
      b: "draft B",
    });
  });
  it("late file suggestions remain scoped to the captured room", async () => {
    await useStore.getState().selectAgentSession("a");
    let release!: (value: Response) => void;
    route = (url) =>
      url.includes("/content/workspaces/w-a/files")
        ? new Promise((resolve) => {
            release = resolve;
          })
        : json([]);
    const searching = useStore.getState().searchWorkspacePaths("old");
    await useStore.getState().selectAgentSession("b");
    release(json([{ relativePath: "a-only.ts", kind: "file" }]));
    await searching;
    expect(useStore.getState().workspacePathResults).toEqual([]);
  });
});

it("reuses the same request identity after an uncertain network submission", async () => {
  useStore.setState({ currentSessionId: "a" });
  const bodies: Array<{ clientRequestId: string }> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    throw new Error("network lost");
  }) as unknown as typeof fetch;
  await useStore.getState().sendRoomCommand("same task", [], "execute");
  await useStore.getState().sendRoomCommand("same task", [], "execute");
  await useStore.getState().sendRoomCommand("changed task", [], "execute");
  expect(bodies[0].clientRequestId).toBe(bodies[1].clientRequestId);
  expect(bodies[2].clientRequestId).not.toBe(bodies[1].clientRequestId);
});

it("returns the saved role identity and explicitly clears temperature", async () => {
  const saved = { id: "new-role", nickname: "New role" };
  const payloads: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      payloads.push(JSON.parse(String(init.body)));
      return json(saved);
    }
    return json([saved]);
  }) as unknown as typeof fetch;
  const result = await useStore.getState().saveAgent(
    {
      nickname: "New role",
      avatar: "",
      providerId: "p",
      modelId: "m",
      role: "",
      systemPrompt: "",
      temperature: "",
      contextWindowTokens: "",
      contextWindowDirty: false,
      reasoningEffort: "auto",
    },
    null,
  );
  expect(result.id).toBe("new-role");
  expect(payloads[0].temperature).toBeNull();
  expect(useStore.getState().agents[0].id).toBe(result.id);
});

it("reconciles a cached active projection with authoritative terminal state", async () => {
  useStore.setState({
    currentSessionId: "a",
    agentRunning: true,
    activeAgentRunId: "finished-run",
    agentStreamText: "old output",
    pendingApprovals: [
      {
        id: "old-approval",
        subjectId: "op",
        kind: "tool",
        risk: "low",
        freshHumanRequired: false,
        status: "pending",
      },
    ],
  });
  route = (url) =>
    url.includes("/room-commands/rooms/a")
      ? json([
          {
            kind: "direct",
            commandId: "command",
            runId: "finished-run",
            status: "completed",
          },
        ])
      : json([]);
  await useStore.getState().selectAgentSession("a");
  expect(useStore.getState().agentRunning).toBe(false);
  expect(useStore.getState().activeAgentRunId).toBeNull();
  expect(useStore.getState().agentStreamText).toBe("");
  expect(useStore.getState().pendingApprovals).toEqual([]);
});
it("locks continuation before the POST returns so repeated clicks cannot create two runs", async () => {
  useStore.setState({
    currentSessionId: "a",
    lastStoppedRunId: "budget-run",
    agentRunning: false,
  });
  let reject!: (error: Error) => void;
  let requests = 0;
  globalThis.fetch = ((_input: RequestInfo | URL) => {
    requests++;
    return new Promise((_resolve, fail) => {
      reject = fail;
    });
  }) as unknown as typeof fetch;
  const first = useStore.getState().continueAgentRun();
  await useStore.getState().continueAgentRun();
  expect(requests).toBe(1);
  expect(useStore.getState().agentRunning).toBe(true);
  reject(new Error("offline"));
  await first;
  expect(useStore.getState().agentRunning).toBe(false);
});
it("late message refresh preserves newer messages and deduplicates stable identities", () => {
  const current = [
    { id: "new", sequence: 2 },
    { id: "old", sequence: 1, content: "initial" },
  ];
  const incoming = [{ id: "old", sequence: 1, content: "updated" }];
  const messages = mergeSessionMessages(current as never, incoming as never);
  expect(messages.map((message) => message.id)).toEqual(["old", "new"]);
  expect(messages[0].content).toBe("updated");
});

for (const scope of ["agent", "multi"] as const)
  it(`${scope} approval retry keeps its idempotency key after a committed-but-failed response`, async () => {
    const bodies: Array<{ decision: string; clientDecisionKey: string }> = [];
    let fail = true;
    globalThis.fetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (fail) throw new Error("delivery failed after commit");
      return json({ ok: true });
    }) as unknown as typeof fetch;
    const decide =
      scope === "agent"
        ? useStore.getState().decideAgentApproval
        : useStore.getState().decideMultiApproval;
    if (scope === "agent")
      await expect(decide("request", "allow_once")).rejects.toThrow(
        "delivery failed",
      );
    else await decide("request", "allow_once");
    fail = false;
    await decide("request", "allow_once");
    expect(bodies[0].clientDecisionKey).toBe(bodies[1].clientDecisionKey);
    await decide("new-request", "deny");
    expect(bodies[2].clientDecisionKey).not.toBe(bodies[1].clientDecisionKey);
  });

it("only sends unknown-outcome confirmation when explicitly provided", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init.body)),
      });
      return json({ ok: true });
    }
    return json({ id: "task", sessionId: "a" });
  }) as unknown as typeof fetch;
  await useStore.getState().retryWorkPackage("task", "task/package");
  await useStore.getState().retryWorkPackage("task", "task/package", true);
  await useStore.getState().retryWorkPackage("task", "task/package", false);
  expect(requests[0].body).toEqual({});
  expect(requests[1].body).toEqual({ confirmOutcomeUnknown: true });
  expect(requests[2].body).toEqual({});
  expect(requests[0].url).toContain("task%2Fpackage/retry");
});
