import { describe, expect, it } from "bun:test";
import type { ConversationSession, WorkspaceRecord } from "@socrates/core";
import { revealResolvedSidebarTarget, resolveSidebarRevealPath } from "./revealInFinder";

const workspace = (id: string, canonicalPath: string): WorkspaceRecord => ({
  id,
  canonicalPath,
  displayPath: canonicalPath,
  identityHash: `hash-${id}`,
  label: id,
  ownership: "external",
  ownerSessionId: null,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
});

const session = (id: string, workspaceId: string | null): ConversationSession => ({
  id,
  title: id,
  mode: "single_agent",
  kind: "cowork",
  collaboration: {} as ConversationSession["collaboration"],
  approvalPolicy: { mode: "ask", version: 1 },
  workspaceId,
  primaryAgentId: "agent",
  archived: false,
  status: "idle",
  legacyRoomId: null,
  agents: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("sidebar Reveal in Finder target", () => {
  const workspaces = [
    workspace("project", "/Users/test/Projects/Socrates"),
    workspace("conversation", "/Users/test/Documents/Socrates/Workspaces/room-1"),
  ];
  const sessions = [session("room-1", "conversation"), session("legacy", null)];

  it("reveals a project at its canonical workspace path", () => {
    expect(resolveSidebarRevealPath(
      { kind: "workspace", id: "project" },
      sessions,
      workspaces,
    )).toEqual({ status: "ready", path: "/Users/test/Projects/Socrates" });
  });

  it("reveals a conversation at the path of its persisted workspace binding", () => {
    expect(resolveSidebarRevealPath(
      { kind: "session", id: "room-1" },
      sessions,
      workspaces,
    )).toEqual({
      status: "ready",
      path: "/Users/test/Documents/Socrates/Workspaces/room-1",
    });
  });

  it("does not invent paths for legacy Chat rooms or unbound sessions", () => {
    expect(resolveSidebarRevealPath({ kind: "room", id: "chat" }, sessions, workspaces)).toBeNull();
    expect(resolveSidebarRevealPath({ kind: "session", id: "legacy" }, sessions, workspaces)).toBeNull();
  });

  it("keeps a stale workspace binding actionable so the menu can surface an explicit error", async () => {
    const target = resolveSidebarRevealPath(
      { kind: "session", id: "orphan" },
      [...sessions, session("orphan", "missing")],
      workspaces,
    );
    expect(target).toEqual({ status: "missing", workspaceId: "missing" });
    if (!target) throw new Error("expected stale binding resolution");
    await expect(revealResolvedSidebarTarget(target, async () => {}))
      .rejects.toThrow("workspace_not_found");
  });

  it("invokes the native reveal adapter exactly once for a ready target", async () => {
    const calls: string[] = [];
    const target = resolveSidebarRevealPath({ kind: "workspace", id: "project" }, sessions, workspaces);
    if (!target) throw new Error("expected ready reveal resolution");
    await revealResolvedSidebarTarget(target, async (path) => {
      calls.push(path);
    });
    expect(calls).toEqual(["/Users/test/Projects/Socrates"]);
  });
});
