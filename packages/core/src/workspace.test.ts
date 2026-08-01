import { describe, expect, it } from "bun:test";
import { isReusableProjectWorkspace, normalizeWorkspaceRelativePath, type WorkspaceRecord } from "./workspace";

const workspace = (ownership: "external" | "managed", archived = false): WorkspaceRecord => ({
  id: "workspace",
  canonicalPath: "/workspace",
  displayPath: "/workspace",
  identityHash: "hash",
  label: "Workspace",
  ownership,
  ownerSessionId: ownership === "managed" ? "owner" : null,
  archived,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
});

describe("workspace references", () => {
  it("normalizes safe relative paths", () => {
    expect(normalizeWorkspaceRelativePath("./src//index.ts")).toBe("src/index.ts");
    expect(normalizeWorkspaceRelativePath(".")).toBe("");
  });

  it("rejects traversal, absolute paths and null bytes", () => {
    for (const path of ["../secret", "/tmp/file", "C:\\secret", "a\0b"]) {
      expect(() => normalizeWorkspaceRelativePath(path)).toThrow();
    }
  });

  it("allows only active external workspaces to be reused as projects", () => {
    expect(isReusableProjectWorkspace(workspace("external"))).toBe(true);
    expect(isReusableProjectWorkspace(workspace("external", true))).toBe(false);
    expect(isReusableProjectWorkspace(workspace("managed"))).toBe(false);
    expect(isReusableProjectWorkspace(null)).toBe(false);
  });
});
