import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ConversationSession } from "@socrates/core";
import { mergeSessionMessages, storedRoomNavigation, useStore } from "./store";

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
    workspaces: [{ id: "w-a", canonicalPath: "/a" }, { id: "w-b", canonicalPath: "/b" }] as never,
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
  it("late instruction acknowledgement clears only submitted files in its source room", async()=>{
    await useStore.getState().selectAgentSession("a");
    useStore.setState({draftAttachments:[{id:"a-sent"},{id:"a-new"}] as never,draftWorkspaceRefs:[{id:"a-ref"}] as never});
    await useStore.getState().selectAgentSession("b");
    useStore.setState({draftAttachments:[{id:"b-file"}] as never,draftWorkspaceRefs:[{id:"b-ref"}] as never});
    useStore.getState().clearSubmittedRoomFiles("a",["a-sent"],["a-ref"]);
    expect(useStore.getState().draftAttachments.map(a=>a.id)).toEqual(["b-file"]);
    expect(useStore.getState().draftWorkspaceRefs.map(a=>a.id)).toEqual(["b-ref"]);
    await useStore.getState().selectAgentSession("a");
    expect(useStore.getState().draftAttachments.map(a=>a.id)).toEqual(["a-new"]);
    expect(useStore.getState().draftWorkspaceRefs).toEqual([]);
  });

  for (const source of ["workspace", "clipboard"] as const) it(`keeps late ${source} imports in the originating room`, async () => {
    await useStore.getState().selectAgentSession("a");
    let release!: (value: Response) => void;
    route = url => url.includes("/content/attachments/") ? new Promise(resolve => { release = resolve; }) : json([]);
    const importing = source === "workspace"
      ? useStore.getState().importWorkspaceAttachment("/a/report.txt")
      : useStore.getState().importClipboardAttachment(new File(["content"], "report.txt"));
    await useStore.getState().selectAgentSession("b");
    release(json({ id: "attachment-a", byteSize: 7 }));
    await importing;
    expect(useStore.getState().draftAttachments).toEqual([]);
    expect(useStore.getState().roomProjections.a.draftAttachments.map(item => item.id)).toEqual(["attachment-a"]);
    await useStore.getState().selectAgentSession("a");
    expect(useStore.getState().draftAttachments.map(item => item.id)).toEqual(["attachment-a"]);
  });
  it("rejects a late history snapshot after a newer snapshot has committed", async () => {
    let release!: (value: Response) => void;
    let count = 0;
    route = url => url.includes("/sessions/a/messages")
      ? ++count === 1 ? new Promise(resolve => { release = resolve; }) : json([{id:"user",sequence:1}, {id:"answer",sequence:2}])
      : json([]);
    const old = useStore.getState().selectAgentSession("a");
    await useStore.getState().selectAgentSession("a");
    release(json([{id:"user",sequence:1}]));
    await old;
    expect(useStore.getState().sessionMessages.map(item => item.id)).toEqual(["user", "answer"]);
  });
  it("rewind rejects pre-rewind history and preserves an explicitly empty history", async () => {
    useStore.setState({currentSessionId:"a", sessionMessages:[{id:"answer",sequence:2}] as never});
    let release!: (value: Response) => void;
    let count = 0;
    route = url => url.includes("/sessions/a/messages") && ++count === 1
      ? new Promise(resolve => { release = resolve; }) : json([]);
    const old = useStore.getState().selectAgentSession("a");
    await useStore.getState().rewindSessionTo("answer");
    release(json([{id:"answer",sequence:2}]));
    await old;
    expect(useStore.getState().sessionMessages).toEqual([]);
  });
  for (const action of ["resumeMultiTask", "retryMultiTask"] as const) it(`keeps ${action} failures and final refresh in their room`, async () => {
    const task = {id:"task-a", sessionId:"a", state:"paused", pendingApprovals:[], usageSummaries:[]};
    useStore.setState({currentSessionId:"a",currentMultiTask:task as never});
    let reject!: (value: Error) => void;
    route = url => /\/(resume|retry)$/.test(url) ? new Promise((_resolve, fail) => {reject=fail;}) : url.endsWith("/multi/tasks/task-a") ? json(task) : json([]);
    const pending = useStore.getState()[action]();
    await useStore.getState().selectAgentSession("b");
    useStore.setState({multiRunning:true, multiError:"B status"});
    reject(new Error("A failed"));
    await pending;
    expect(useStore.getState().multiRunning).toBe(true);
    expect(useStore.getState().multiError).toBe("B status");
    expect(useStore.getState().roomProjections.a.multiError).toBe("A failed");
  });
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

it("keeps an entire attachment batch and its failures with a captured target", async () => {
  await useStore.getState().selectAgentSession("a");
  const target=useStore.getState().captureRoomTarget();
  let release!: (value: Response) => void;
  const requested: string[]=[];
  globalThis.fetch=(async (input: RequestInfo | URL, init?:RequestInit) => {
    if(String(input).includes("/content/attachments/import")) {
      const body=JSON.parse(String(init?.body)); requested.push(body.workspaceId);
      if(requested.length === 1) return new Promise(resolve=>{release=resolve;});
      throw new Error("second file failed");
    }
    return json([]);
  }) as unknown as typeof fetch;
  const batch=(async()=>{
    await useStore.getState().importWorkspaceAttachment("/a/one.txt",target);
    await useStore.getState().importWorkspaceAttachment("/a/two.txt",target).catch(()=>{});
  })();
  await useStore.getState().selectAgentSession("b");
  release(json({id:"one",byteSize:1}));
  await batch;
  expect(requested).toEqual(["w-a","w-a"]);
  expect(useStore.getState().attachmentError).toBeNull();
  expect(useStore.getState().attachmentImports).toBe(0);
  expect(useStore.getState().roomProjections.a.attachmentError).toBe("second file failed");
  expect(useStore.getState().roomProjections.a.attachmentImports).toBe(0);
});

it("restores only live selections in the requested mode and resolves legacy aliases", async () => {
  useStore.setState({
    rooms:[{id:"old",name:"Archived",archived:true,agentIds:["member"]}] as never,
    sessions:[{...sessions[0],id:"upgraded",legacyRoomId:"old",kind:"chat",archived:true},{...sessions[1],kind:"chat",archived:false}] as never,
    roomNavigation:{mode:"chat",selected:{chat:"old",cowork:"b"}},
  });
  await useStore.getState().setAppMode("chat");
  expect(useStore.getState().currentSessionId).toBe("b");
  await useStore.getState().selectRoom("old");
  expect(useStore.getState().currentSessionId).toBe("upgraded");
  expect(useStore.getState().currentRoomId).toBeNull();
  await useStore.getState().setAppMode("cowork");
  expect(useStore.getState().currentSessionId).toBeNull();
  expect(useStore.getState().roomNavigation.mode).toBe("cowork");
});

it("submits room, mentions and attachments from one explicit room snapshot", async () => {
  await useStore.getState().selectAgentSession("a");
  useStore.getState().setComposerDraft("a","@Alice draft A");
  useStore.getState().setComposerMentions("a",[{label:"@Alice",mention:{type:"agent",agentId:"alice"}}]);
  useStore.setState({draftAttachments:[{id:"a-file"}] as never,draftWorkspaceRefs:[{id:"a-ref"}] as never});
  await useStore.getState().selectAgentSession("b");
  let submitted: Record<string,unknown> | undefined;
  globalThis.fetch=(async (_input: RequestInfo | URL, init?:RequestInit) => {submitted=JSON.parse(String(init?.body));throw new Error("offline");}) as unknown as typeof fetch;
  await useStore.getState().sendRoomCommand("@Alice draft A",[{type:"agent",agentId:"alice"}],"execute",undefined,"a");
  expect(submitted).toMatchObject({roomId:"a",mentions:[{type:"agent",agentId:"alice"}],attachmentIds:["a-file"],workspaceRefIds:["a-ref"]});
  expect(useStore.getState().agentError).toBeNull();
  expect(useStore.getState().roomProjections.a.agentError).toBe("offline");
  expect(useStore.getState().composerDrafts.a).toBe("@Alice draft A");
});

const eventually = async (predicate:()=>boolean) => {
  const until=Date.now()+2500;
  while(!predicate() && Date.now()<until) await Bun.sleep(5);
  expect(predicate()).toBe(true);
};

it("streams Team authors in their room across switching and reconnect without duplicate final messages", async () => {
  useStore.setState({currentSessionId:"a"});
  const streams: ReadableStreamDefaultController<Uint8Array>[]=[];
  const cursors:string[]=[];
  let completed=false;
  let phase="discussing";
  const task=()=>({id:"team-a",sessionId:"a",state:completed ? "completed" : phase,turns:[],pendingApprovals:[],usageSummaries:[]});
  globalThis.fetch=(async (input: RequestInfo | URL, init?:RequestInit) => {
    const url=String(input);
    if(url.endsWith("/room-commands") && init?.method === "POST") return json({kind:"team",taskId:"team-a",commandId:"command-a"});
    if(url.includes("/room-commands/command-a/events")) {
      cursors.push(url);
      return new Response(new ReadableStream({start(controller){streams.push(controller);}}),{headers:{"Content-Type":"text/event-stream"}});
    }
    if(url.endsWith("/room-commands/command-a")) return json({status:completed ? "completed" : "running"});
    if(url.endsWith("/room-commands/rooms/a")) return json([{kind:"team",taskId:"team-a",commandId:"command-a",status:completed ? "completed" : "running"}]);
    if(url.endsWith("/multi/tasks/team-a")) return json(task());
    if(url.endsWith("/multi/sessions/a/tasks")) return json([task()]);
    if(url.endsWith("/sessions/a/messages")) return json(completed ? [{id:"answer",sequence:2,authorId:"alice",content:"Hello world"}] : []);
    if(url.endsWith("/sessions")) return json(sessions);
    return json([]);
  }) as unknown as typeof fetch;
  const emit=(index:number,event:Record<string,unknown>)=>streams[index].enqueue(new TextEncoder().encode(`data: ${JSON.stringify({roomId:"a",taskId:"team-a",...event})}\n\n`));
  await useStore.getState().sendRoomCommand("do work",[],"execute");
  await eventually(()=>streams.length === 1);
  emit(0,{seq:1,type:"turn_started",turnId:"turn-a",agentId:"alice"});
  emit(0,{seq:2,type:"delta",turnId:"turn-a",agentId:"alice",text:"Hello"});
  await eventually(()=>useStore.getState().multiLiveStreams["turn-a"]?.text === "Hello");
  await useStore.getState().selectAgentSession("b");
  emit(0,{seq:3,type:"delta",turnId:"turn-a",agentId:"alice",text:" world"});
  await eventually(()=>useStore.getState().roomProjections.a.multiLiveStreams["turn-a"]?.text === "Hello world");
  expect(useStore.getState().multiLiveStreams).toEqual({});
  phase="awaiting_plan_approval";
  // Old servers can emit task_failed for a recoverable reviewer failure.
  emit(0,{seq:4,type:"task_failed"});
  streams[0].close();
  await eventually(()=>streams.length === 2);
  expect(cursors[1]).toContain("afterSeq=4");
  emit(1,{seq:3,type:"delta",turnId:"turn-a",agentId:"alice",text:" world"});
  await useStore.getState().selectAgentSession("a");
  expect(useStore.getState().multiLiveStreams["turn-a"]).toEqual({agentId:"alice",text:"Hello world"});
  completed=true;
  emit(1,{seq:5,type:"turn_completed",turnId:"turn-a",agentId:"alice"});
  emit(1,{seq:6,type:"task_completed"});
  streams[1].close();
  await eventually(()=>!useStore.getState().multiRunning && useStore.getState().sessionMessages.length === 1);
  expect(useStore.getState().sessionMessages.map(message=>message.id)).toEqual(["answer"]);
  expect(useStore.getState().multiLiveStreams).toEqual({});
});

it("a completed command wins over its delayed initial history request", async () => {
  useStore.setState({currentSessionId:"a"});
  let release!: (value:Response)=>void;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let reads=0;
  globalThis.fetch=(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith("/room-commands") && init?.method === "POST") return json({kind:"discussion",commandId:"discussion-a"});
    if(url.includes("/room-commands/discussion-a/events")) return new Response(new ReadableStream({start(controller){stream=controller;}}));
    if(url.endsWith("/sessions/a/messages")) return ++reads === 1 ? new Promise(resolve=>{release=resolve;}) : json([{id:"user",sequence:1},{id:"answer",sequence:2}]);
    if(url.endsWith("/sessions")) return json(sessions);
    return json([]);
  }) as unknown as typeof fetch;
  await useStore.getState().sendRoomCommand("question",[],"discuss");
  stream.enqueue(new TextEncoder().encode('data: {"seq":1,"type":"message","message":{"id":"answer","sequence":2}}\n\ndata: {"seq":2,"type":"completed"}\n\n'));
  stream.close();
  await eventually(()=>useStore.getState().sessionMessages.length === 2);
  release(json([{id:"user",sequence:1}]));
  await Bun.sleep(5);
  expect(useStore.getState().sessionMessages.map(message=>message.id)).toEqual(["user","answer"]);
});

it("late command events cannot revive messages after rewind", async () => {
  useStore.setState({currentSessionId:"a"});
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch=(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith("/room-commands") && init?.method === "POST") return json({kind:"discussion",commandId:"rewound-command"});
    if(url.includes("/room-commands/rewound-command/events")) return new Response(new ReadableStream({start(controller){stream=controller;}}));
    if(url.endsWith("/sessions")) return json(sessions);
    return json([]);
  }) as unknown as typeof fetch;
  await useStore.getState().sendRoomCommand("question",[],"discuss");
  stream.enqueue(new TextEncoder().encode('data: {"seq":1,"type":"message","message":{"id":"answer","sequence":2}}\n\ndata: {"seq":2,"type":"completed"}\n\n'));
  await eventually(()=>!useStore.getState().agentRunning && useStore.getState().sessionMessages.length === 1);
  await useStore.getState().rewindSessionTo("answer");
  stream.enqueue(new TextEncoder().encode('data: {"seq":3,"type":"message","message":{"id":"answer","sequence":2}}\n\n'));
  stream.close();
  await Bun.sleep(10);
  expect(useStore.getState().sessionMessages).toEqual([]);
  expect(useStore.getState().historyGeneration).toBe(1);
  expect(useStore.getState().activeRoomCommandId).toBeNull();
});

it("rewind clears the deleted budget-stopped run's recovery and approval controls", async () => {
  useStore.setState({currentSessionId:"a",lastStoppedRunId:"deleted-run",agentError:"budget_exhausted",agentEvents:[{type:"text_delta",text:"old"}],pendingApprovals:[{id:"old"}] as never});
  await useStore.getState().rewindSessionTo("answer");
  expect(useStore.getState().lastStoppedRunId).toBeNull();
  expect(useStore.getState().agentError).toBeNull();
  expect(useStore.getState().pendingApprovals).toEqual([]);
  expect(useStore.getState().agentEvents).toEqual([]);
  let requests=0;
  route=()=>{requests++;return json([]);};
  await useStore.getState().continueAgentRun();
  expect(requests).toBe(0);
});

it("persists both mode selections and restores the valid selected room at startup", async () => {
  const previousWindow=Object.getOwnPropertyDescriptor(globalThis,"window");
  const values=new Map<string,string>();
  Object.defineProperty(globalThis,"window",{configurable:true,value:{localStorage:{getItem:(key:string)=>values.get(key) ?? null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}}}});
  const rooms=[{...sessions[0],kind:"chat"},{...sessions[1],kind:"cowork"}] as ConversationSession[];
  try {
    useStore.setState({sessions:rooms});
    await useStore.getState().selectAgentSession("a");
    await useStore.getState().setAppMode("cowork");
    expect(storedRoomNavigation()).toEqual({mode:"cowork",selected:{chat:"a",cowork:"b"}});
    // Apply the exact initialization read used by the production Store, as on reload.
    useStore.setState({...useStore.getInitialState(),handshake:{port:1,token:"test"},sessions:rooms,roomNavigation:storedRoomNavigation()});
    await useStore.getState().setAppMode(useStore.getState().roomNavigation.mode);
    expect(useStore.getState().currentSessionId).toBe("b");
    await useStore.getState().setAppMode("chat");
    expect(useStore.getState().currentSessionId).toBe("a");
    expect(storedRoomNavigation()).toEqual({mode:"chat",selected:{chat:"a",cowork:"b"}});
  } finally {
    if(previousWindow) Object.defineProperty(globalThis,"window",previousWindow);
    else Reflect.deleteProperty(globalThis,"window");
  }
});

it("projects Worker text and approvals from Team SSE without a mounted polling component", async () => {
  useStore.setState({currentSessionId:"a"});
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let finished=false,approval=false;
  const pending=[{id:"worker-approval",subjectId:"write",kind:"tool",risk:"low",freshHumanRequired:false,status:"pending"}];
  globalThis.fetch=(async (input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);
    if(url.endsWith("/room-commands") && init?.method === "POST") return json({kind:"team",taskId:"worker-team",commandId:"worker-command"});
    if(url.includes("/room-commands/worker-command/events")) return new Response(new ReadableStream({start(controller){stream=controller;}}));
    if(url.endsWith("/room-commands/worker-command")) return json({status:finished ? "completed" : "executing"});
    if(url.endsWith("/multi/tasks/worker-team")) return json({id:"worker-team",sessionId:"a",state:finished ? "completed" : "executing",turns:[],pendingApprovals:approval ? pending : [],usageSummaries:[]});
    if(url.endsWith("/sessions/a/messages")) return json(finished ? [{id:"worker-answer",sequence:1,authorId:"worker",content:"Finished"}] : []);
    if(url.endsWith("/sessions")) return json(sessions);
    return json([]);
  }) as unknown as typeof fetch;
  await useStore.getState().sendRoomCommand("work",[],"execute");
  await eventually(()=>Boolean(stream));
  const emit=(seq:number,type:string,payload:Record<string,unknown>)=>stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({seq,type,roomId:"a",taskId:"worker-team",payload})}\n\n`));
  emit(1,"multi.package_runtime",{runId:"worker-run",packageId:"package",agentId:"worker",event:{type:"text_delta",text:"Working"}});
  await eventually(()=>useStore.getState().multiLiveStreams["worker-run"]?.text === "Working");
  expect(useStore.getState().multiLiveStreams["worker-run"].agentId).toBe("worker");
  approval=true;
  emit(2,"multi.package_runtime",{runId:"worker-run",packageId:"package",agentId:"worker",event:{type:"approval_required",requestId:"worker-approval"}});
  await eventually(()=>useStore.getState().pendingApprovals.length === 1);
  finished=true;approval=false;
  emit(3,"multi.package_finished",{id:"package",runId:"worker-run",executorAgentId:"worker"});
  emit(4,"multi.team_completed",{});
  stream.close();
  await eventually(()=>useStore.getState().activeRoomCommandId === null);
  expect(useStore.getState().multiLiveStreams).toEqual({});
  expect(useStore.getState().sessionMessages.map(message=>message.id)).toEqual(["worker-answer"]);
});

it("follows an adaptive parent across temporary transport failure and a completed child without declaring success", async () => {
  let reads=0,finish=false;
  const command={commandId:"adaptive-root",kind:"team",adaptive:true,taskId:"adaptive-child",status:"paused",routeStatus:"awaiting_verification"};
  const task={id:"adaptive-child",sessionId:"a",state:"completed",config:{costRootTaskId:"adaptive-root"},pendingApprovals:[],usageSummaries:[]};
  route=url=>{
    if(url.endsWith("/room-commands/rooms/a"))return json([command]);
    if(url.endsWith("/room-commands/adaptive-root")){
      reads++;if(reads===1)throw Error("temporary local connection loss");
      return json({...command,status:finish?"completed":"paused",routeStatus:finish?"completed":"awaiting_verification"});
    }
    if(url.includes("/room-commands/adaptive-root/events"))return new Response("",{headers:{"content-type":"text/event-stream"}});
    if(url.endsWith("/multi/tasks/adaptive-child"))return json(task);
    if(url.endsWith("/sessions"))return json(sessions);
    return json([]);
  };
  try {
    await useStore.getState().selectAgentSession("a");
    await eventually(()=>reads>=2&&useStore.getState().currentMultiTask?.id===task.id);
    expect(useStore.getState().commandExecutionKind).toBe("team");
    expect(useStore.getState().adaptiveCommandId).toBe("adaptive-root");
    expect(useStore.getState().activeRoomCommandId).toBe("adaptive-root");
    expect(useStore.getState().multiRunning).toBe(false);
    expect(useStore.getState().adaptiveStatus).toBe("awaiting_verification");
    expect(useStore.getState().agentError).toBeNull();
    await useStore.getState().selectAgentSession("b");
    finish=true;
    await eventually(()=>useStore.getState().roomProjections.a.adaptiveCommandId===null);
    expect(useStore.getState().currentSessionId).toBe("b");
    expect(useStore.getState().currentMultiTask).toBeNull();
    expect(useStore.getState().commandExecutionKind).toBeNull();
    expect(useStore.getState().roomProjections.a.commandExecutionKind).toBe("team");
  } finally {
    finish=true;
    await eventually(()=>useStore.getState().roomProjections.a?.adaptiveCommandId===null||useStore.getState().adaptiveCommandId===null);
  }
});
