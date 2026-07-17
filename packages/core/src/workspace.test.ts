import { describe, expect, it } from "bun:test";
import { normalizeWorkspaceRelativePath } from "./workspace";

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
});
