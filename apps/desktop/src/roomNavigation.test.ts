import { describe, expect, it } from "bun:test";
import {
  initialRoomNavigation,
  navigateRoom,
  switchRoomMode,
  roomMentionQuery,
  retainSelectedMentions,
} from "./roomNavigation";

describe("Chat / Work navigation", () => {
  it("remembers each mode's room and preserves the other selection", () => {
    let nav = navigateRoom(initialRoomNavigation(), "chat", "c");
    nav = navigateRoom(nav, "cowork", "w");
    expect(switchRoomMode(nav, "chat")).toEqual({
      mode: "chat",
      selected: { chat: "c", cowork: "w" },
    });
  });
  it("only opens mention suggestions in user prose", () => {
    expect(roomMentionQuery("hello @a")).toBe("a");
    expect(roomMentionQuery("```\n@a")).toBeNull();
    expect(roomMentionQuery("> @a")).toBeNull();
    expect(roomMentionQuery("`@a")).toBeNull();
    expect(roomMentionQuery("mail@a")).toBeNull();
  });
  it("keeps only menu-selected tokens that remain in the draft", () => {
    expect(
      retainSelectedMentions("quoted @Ada", [
        { label: "@Ada", mention: { type: "agent", agentId: "a" } },
      ]),
    ).toHaveLength(1);
    expect(
      retainSelectedMentions("```\n@Ada\n```", [
        { label: "@Ada", mention: { type: "agent", agentId: "a" } },
      ]),
    ).toHaveLength(0);
    expect(
      retainSelectedMentions("> @Ada", [
        { label: "@Ada", mention: { type: "agent", agentId: "a" } },
      ]),
    ).toHaveLength(0);
    expect(
      retainSelectedMentions("@Adam", [
        { label: "@Ada", mention: { type: "agent", agentId: "a" } },
      ]),
    ).toHaveLength(0);
    expect(
      retainSelectedMentions("`@Ada`", [
        { label: "@Ada", mention: { type: "agent", agentId: "a" } },
      ]),
    ).toHaveLength(0);
    expect(
      retainSelectedMentions("deleted", [
        { label: "@Ada", mention: { type: "agent", agentId: "a" } },
      ]),
    ).toHaveLength(0);
  });
});
