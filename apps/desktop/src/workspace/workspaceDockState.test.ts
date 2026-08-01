import { describe, expect, it } from "bun:test";
import { toggleWorkspaceDock } from "./workspaceDockState";

describe("toggleWorkspaceDock", () => {
  it("opens, switches and closes the shared workspace dock", () => {
    expect(toggleWorkspaceDock("closed", "files", true)).toBe("files");
    expect(toggleWorkspaceDock("files", "diff", true)).toBe("diff");
    expect(toggleWorkspaceDock("diff", "diff", true)).toBe("closed");
  });

  it("fails closed without an active workspace", () => {
    expect(toggleWorkspaceDock("files", "diff", false)).toBe("closed");
  });
});
