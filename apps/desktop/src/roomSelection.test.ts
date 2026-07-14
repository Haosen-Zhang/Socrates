import { describe, expect, it } from "bun:test";
import { toggleRoomAgentSelection } from "./roomSelection";

describe("toggleRoomAgentSelection", () => {
  it("adds agents in selection order and removes only the toggled agent", () => {
    expect(toggleRoomAgentSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleRoomAgentSelection(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });
});
