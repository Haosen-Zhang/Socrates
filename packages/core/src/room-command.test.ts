import { expect, test } from "bun:test";
import { resolveRoomCommand } from "./room-command";
import { DEFAULT_COLLABORATION_SETTINGS } from "./room-kind";

const room = { kind: "cowork" as const, primaryAgentId: "a", agentIds: ["a", "b"], collaboration: DEFAULT_COLLABORATION_SETTINGS };
test("structured target is local to the command; ordinary @ text never routes", () => {
  expect(resolveRoomCommand(room, { intent: "execute", mentions: [] })).toEqual({ kind: "direct", agentIds: ["a"] });
  expect(resolveRoomCommand(room, { intent: "execute", mentions: [{ type: "agent", agentId: "b" }] })).toEqual({ kind: "direct", agentIds: ["b"] });
  expect(room.primaryAgentId).toBe("a");
});
test("all and multiple targets are bounded discussion, never parallel writers", () => {
  expect(resolveRoomCommand(room, { intent: "execute", mentions: [{ type: "all" }] }).kind).toBe("discussion");
  expect(resolveRoomCommand(room, { intent: "respond", mentions: [{ type: "agent", agentId: "b" }, { type: "agent", agentId: "a" }] }).agentIds).toEqual(["b", "a"]);
});
test("chat rejects execution and local file references", () => {
  expect(() => resolveRoomCommand({ ...room, kind: "chat" }, { intent: "execute", mentions: [] })).toThrow("chat_execution_forbidden");
  expect(() => resolveRoomCommand({ ...room, kind: "chat" }, { intent: "respond", mentions: [{ type: "file", refId: "f" }] })).toThrow("chat_file_mentions_forbidden");
});
test("unknown members rejected and explicit team strategy routes through coordinator", () => {
  expect(() => resolveRoomCommand(room, { intent: "execute", mentions: [{ type: "agent", agentId: "outside" }] })).toThrow("mention_must_be_room_member");
  expect(resolveRoomCommand({ ...room, collaboration: { ...room.collaboration, strategy: "team" } }, { intent: "execute", mentions: [{ type: "agent", agentId: "b" }] })).toEqual({ kind: "direct", agentIds: ["b"] });
  expect(resolveRoomCommand({ ...room, collaboration: { ...room.collaboration, strategy: "team" } }, { intent: "execute", mentions: [{ type: "agent", agentId: "b" }, { type: "agent", agentId: "a" }] })).toEqual({ kind: "team", agentIds: ["b", "a"] });
});
