import { describe, expect, it } from "bun:test";
import { canCommitMultiTaskLoad } from "./multiTaskSelection";

describe("multi-task async selection guard", () => {
  it("commits only the task snapshot that still belongs to the selected room", () => {
    expect(canCommitMultiTaskLoad("room-b", "room-b")).toBe(true);
    expect(canCommitMultiTaskLoad("room-b", "room-a")).toBe(false);
    expect(canCommitMultiTaskLoad(null, "room-a")).toBe(false);
  });
});
