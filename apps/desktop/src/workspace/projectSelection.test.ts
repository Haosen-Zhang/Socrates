import { describe, expect, it } from "bun:test";
import type { WorkspaceRecord } from "@socrates/core";
import { resolveActiveWorkspace, roomTitleOrFallback } from "./projectSelection";

const workspace = (id: string): WorkspaceRecord => ({
  id,
  canonicalPath: `/${id}`,
  displayPath: `/${id}`,
  identityHash: id,
  label: id,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
});

describe("project selection", () => {
  it("does not auto-select the first known workspace", () => {
    expect(resolveActiveWorkspace([workspace("first")], null, null)).toBeNull();
  });

  it("retains only an explicit current or persisted selection", () => {
    const choices = [workspace("first"), workspace("second")];
    expect(resolveActiveWorkspace(choices, null, "second")?.id).toBe("second");
    expect(resolveActiveWorkspace(choices, workspace("first"), "second")?.id).toBe("first");
  });

  it("does not silently retain an archived project as the active target", () => {
    const archived = { ...workspace("old"), archived: true };
    expect(resolveActiveWorkspace([archived], archived, "old")).toBeNull();
  });

  it("uses a fallback title for quick room creation", () => {
    expect(roomTitleOrFallback("   ", "New chat")).toBe("New chat");
    expect(roomTitleOrFallback("Review", "New chat")).toBe("Review");
  });
});
