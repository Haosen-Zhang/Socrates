import { describe, expect, it } from "bun:test";
import { relativeWorkspacePath } from "./workspacePath";

describe("relativeWorkspacePath", () => {
  it("converts a child path and rejects prefix tricks/outside paths", () => {
    expect(relativeWorkspacePath("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(() => relativeWorkspacePath("/repo", "/repo-evil/a.ts")).toThrow("file_outside_workspace");
    expect(() => relativeWorkspacePath("/repo", "/tmp/a.ts")).toThrow("file_outside_workspace");
  });
});
