import { expect, test } from "bun:test";
import type { WorkActivityDetail, WorkActivityRecord } from "@socrates/core";
import { EventStore } from "../store/event-store";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";

const activityPath = (roomId: string, id?: string) => `/room-commands/rooms/${roomId}/activity${id ? `/${encodeURIComponent(id)}` : ""}`;

test("an invalid stored activity reports a read failure rather than missing history", async () => {
  const f=await setupCostFlowFixture();
  try {
    const now=new Date().toISOString();
    f.db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES ('invalid',?,'invalid','invalid','broken json','discussion','failed',?,?)").run(f.roomIds.work,now,now);
    const list=await f.app.request(activityPath(f.roomIds.work),{headers:f.headers});
    expect(list.status).toBe(500);
    expect(await list.json()).toEqual({error:"work_activity_failed"});
    const detail=await f.app.request(activityPath(f.roomIds.work,"command:invalid"),{headers:f.headers});
    expect(detail.status).toBe(500);
    expect(await detail.json()).toEqual({error:"work_activity_failed"});
  } finally {await f.close();}
});

test("Work activity reads real supervised Native facts without another call, write or tool payload", async () => {
  const f = await setupCostFlowFixture();
  try {
    const room = f.sessions.get(f.roomIds.work)!;
    f.sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "single" });
    const command = await f.commands.submit({ roomId: room.id, clientRequestId: "activity-native", content: "Deliver the controlled work", intent: "execute", mentions: [] });
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "completed", "activity_native_complete");
    await f.supervisor.shutdown();
    const counts = { native: f.nativeCalls.length, gateway: f.gatewayCalls.length, changes: f.db.query("SELECT total_changes() AS count").get() };

    const listResponse = await f.app.request(activityPath(room.id), { headers: f.headers });
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as WorkActivityRecord[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: `command:${command.commandId}`, source: "command", roomId: room.id, commandId: command.commandId, runId: command.runId, kind: "direct", prompt: "Deliver the controlled work", status: "completed", attemptNo: 1 });
    const detailResponse = await f.app.request(activityPath(room.id, list[0]!.id), { headers: f.headers });
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as WorkActivityDetail;
    expect(detail.events.some(event => event.type === "run.started")).toBe(true);
    expect(detail.events.some(event => event.type === "run.completed")).toBe(true);
    expect(detail.events.every(event => event.occurredAt && event.runId === command.runId)).toBe(true);
    expect(detail.events.every(event => Object.keys(event).every(key => ["id", "type", "occurredAt", "agentId", "runId"].includes(key)))).toBe(true);
    expect(JSON.stringify(detail.events)).not.toContain("result.txt");
    expect(detail.truncated).toBe(false);
    expect({ native: f.nativeCalls.length, gateway: f.gatewayCalls.length, changes: f.db.query("SELECT total_changes() AS count").get() }).toEqual(counts);
  } finally { await f.close(); }
});

test("activity keeps commandless legacy tasks, deduplicates team commands and scopes timestamped events", async () => {
  const f = await setupCostFlowFixture();
  try {
    const command = await f.commands.submit({ roomId: f.roomIds.work, clientRequestId: "activity-team", content: "Plan the controlled work", intent: "execute", mentions: [] });
    await untilCostFlow(() => f.tasks.get(command.taskId!)?.state === "awaiting_plan_approval", "activity_team_plan");
    const legacy = await f.tasks.create({ sessionId: f.roomIds.work, prompt: "Legacy goal", config: { clientRequestId: "unlinked-legacy", speakingOrder: ["fixture-a", "fixture-b"], maxRounds: 1, synthesizerId: "fixture-a", executionAgentId: "fixture-a" } });
    new EventStore(f.db).append({ eventId: "legacy-observation", sessionId: f.roomIds.work, taskId: legacy.id, type: "multi.state", payload: { state: "preparing", agentId: "fixture-a", secret: "must-not-leak" }, occurredAt: "2026-11-07T10:00:00.000Z" });
    new EventStore(f.db).append({ eventId: "other-room-observation", sessionId: f.roomIds.chat, taskId: legacy.id, type: "multi.state", payload: { secret: "wrong-room-event" } });
    const calls = f.gatewayCalls.length;
    const list = await (await f.app.request(activityPath(f.roomIds.work), { headers: f.headers })).json() as WorkActivityRecord[];
    expect(list.filter(item => item.taskId === command.taskId)).toHaveLength(1);
    expect(list.find(item => item.commandId === command.commandId)).toMatchObject({ kind: "team", status: "awaiting_plan_approval", attemptNo: 1 });
    expect(list.find(item => item.id === `multi-task:${legacy.id}`)).toMatchObject({ source: "legacy_task", taskId: legacy.id, prompt: "Legacy goal", status: "preparing" });
    const detail = await (await f.app.request(activityPath(f.roomIds.work, `multi-task:${legacy.id}`), { headers: f.headers })).json() as WorkActivityDetail;
    expect(detail.events).toEqual([{ id: "legacy-observation", type: "multi.state", occurredAt: "2026-11-07T10:00:00.000Z", agentId: "fixture-a" }]);
    expect(JSON.stringify(detail)).not.toContain("must-not-leak");
    expect(f.gatewayCalls).toHaveLength(calls);
  } finally { await f.close(); }
});

test("direct continuation reports the latest attempt and retains earlier durable Run history", async () => {
  const f = await setupCostFlowFixture();
  try {
    const room = f.sessions.get(f.roomIds.work)!;
    f.sessions.updateCollaboration(room.id, { ...room.collaboration, strategy: "single" });
    const input = { roomId: room.id, content: "Continue the same controlled goal", intent: "execute" as const, mentions: [{ type: "agent" as const, agentId: "fixture-b" }], maxOutputTokens: 256, budget: { mode: "soft_limit" as const, limitAtomic: "100000000" } };
    const quote = f.quotes.quote(input);
    const command = await f.commands.submit({ ...input, quoteId: quote.id, clientRequestId: "activity-continue" });
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "interrupted", "activity_paused");
    f.broker.budgets.increase(command.commandId, { requestId: "activity-increase", expectedRevision: 1, amountAtomic: "1000000000000" });
    await f.costTasks.resume(command.commandId, { requestId: "activity-resume" });
    await untilCostFlow(() => f.commands.get(command.commandId)?.status === "completed", "activity_continued");
    const current = f.commands.get(command.commandId)!;
    expect(current.runId).not.toBe(command.runId);
    const detail = await (await f.app.request(activityPath(room.id, `command:${command.commandId}`), { headers: f.headers })).json() as WorkActivityDetail;
    expect(detail.activity).toMatchObject({ runId: current.runId, attemptNo: 2, status: "completed" });
    expect(detail.events.some(event => event.runId === command.runId && event.type === "run.interrupted")).toBe(true);
    expect(detail.events.some(event => event.runId === current.runId && event.type === "run.completed")).toBe(true);
  } finally { await f.close(); }
});

test("activity rejects Chat, wrong rooms, missing records and revoked commands without re-execution", async () => {
  const f = await setupCostFlowFixture();
  try {
    const command = await f.commands.submit({ roomId: f.roomIds.work, clientRequestId: "activity-discussion", content: "Discuss controlled work", intent: "discuss", mentions: [] });
    await f.commands.wait(command.commandId);
    const room = f.sessions.get(f.roomIds.work)!;
    const other = f.sessions.create({ title: "Other Work", mode: "single_agent", workspaceId: f.workspace.id, primaryAgentId: "fixture-a", agents: [room.agents[0]!] });
    expect((await f.app.request(activityPath(f.roomIds.chat), { headers: f.headers })).status).toBe(409);
    expect((await f.app.request(activityPath("missing-room"), { headers: f.headers })).status).toBe(404);
    expect((await f.app.request(activityPath(other.id, `command:${command.commandId}`), { headers: f.headers })).status).toBe(404);
    expect((await f.app.request(activityPath(room.id, "command:missing"), { headers: f.headers })).status).toBe(404);
    const detail = await (await f.app.request(activityPath(room.id, `command:${command.commandId}`), { headers: f.headers })).json() as WorkActivityDetail;
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.events.every(event => event.occurredAt === null)).toBe(true);
    const user = f.sessions.listMessages(room.id).find(message => message.role === "user")!;
    await f.sessions.rewind(room.id, user.id);
    const calls = f.gatewayCalls.length;
    expect((await f.app.request(activityPath(room.id, `command:${command.commandId}`), { headers: f.headers })).status).toBe(410);
    expect(await (await f.app.request(activityPath(room.id), { headers: f.headers })).json()).toEqual([]);
    expect(f.gatewayCalls).toHaveLength(calls);
  } finally { await f.close(); }
});

test("activity bounds recent records and events while older details remain readable", async () => {
  const f = await setupCostFlowFixture();
  try {
    for (let index = 0; index < 52; index++) {
      const id = `bounded-${index}`;
      const at = new Date(Date.UTC(2026, 10, 7, 0, 0, index)).toISOString();
      f.db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES (?,?,?,?,?,'discussion','completed',?,?)")
        .run(id, f.roomIds.work, id, id, JSON.stringify({ content: `Goal ${index}` }), at, at);
    }
    const insert = f.db.query("INSERT INTO room_command_events(command_id,seq,type,payload_json) VALUES ('bounded-0',?,'turn_started',?)");
    for (let seq = 1; seq <= 505; seq++) insert.run(seq, JSON.stringify({ agentId: "fixture-a", privateText: "must-not-leak" }));
    const list = await (await f.app.request(activityPath(f.roomIds.work), { headers: f.headers })).json() as WorkActivityRecord[];
    expect(list).toHaveLength(50);
    expect(list[0]?.id).toBe("command:bounded-51");
    expect(list.at(-1)?.id).toBe("command:bounded-2");
    const detail = await (await f.app.request(activityPath(f.roomIds.work, "command:bounded-0"), { headers: f.headers })).json() as WorkActivityDetail;
    expect(detail.events).toHaveLength(500);
    expect(detail.events[0]?.id).toBe("discussion:bounded-0:6");
    expect(detail.events.at(-1)?.id).toBe("discussion:bounded-0:505");
    expect(detail.truncated).toBe(true);
    expect(JSON.stringify(detail.events)).not.toContain("must-not-leak");
    expect(f.nativeCalls).toHaveLength(0);
    expect(f.gatewayCalls).toHaveLength(0);
  } finally { await f.close(); }
});
