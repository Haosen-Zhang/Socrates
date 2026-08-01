import { describe, expect, it } from "bun:test";
import type { WorkspaceRecord } from "@socrates/core";
import { prepareNewRoomWorkspace, selectableProjectWorkspaces } from "./newRoomWorkspace";

const workspace = (id: string, ownership: "external" | "managed"): WorkspaceRecord => ({
  id,
  canonicalPath: `/${id}`,
  displayPath: `/${id}`,
  identityHash: id,
  label: id,
  ownership,
  ownerSessionId: ownership === "managed" ? "owner-room" : null,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastOpenedAt: "2026-01-01T00:00:00.000Z",
});

describe("new-room workspace preparation", () => {
  it("maps a temporary conversation to the existing managed-workspace contract", async () => {
    expect(await prepareNewRoomWorkspace({ mode: "temporary", workspaceId: null })).toEqual({ kind: "managed" });
  });

  it("uses a registered workspace without opening the system picker", async () => {
    let picked = false;
    expect(await prepareNewRoomWorkspace({
      mode: "project",
      workspaceId: "workspace-1",
      pickAndRegisterWorkspace: async () => { picked = true; return { id: "ignored" }; },
    })).toEqual({ kind: "existing", workspaceId: "workspace-1" });
    expect(picked).toBe(false);
  });

  it("registers a newly picked local folder and uses its durable workspace id", async () => {
    expect(await prepareNewRoomWorkspace({
      mode: "project",
      workspaceId: null,
      pickAndRegisterWorkspace: async () => ({ id: "workspace-new" }),
    })).toEqual({ kind: "existing", workspaceId: "workspace-new" });
  });

  it("returns cancellation without registering or creating a room", async () => {
    let pickerCalls = 0;
    expect(await prepareNewRoomWorkspace({
      mode: "project",
      workspaceId: null,
      pickAndRegisterWorkspace: async () => {
        pickerCalls += 1;
        return null;
      },
    })).toBeNull();
    expect(pickerCalls).toBe(1);
  });

  it("offers only external workspaces as reusable projects", () => {
    const external = workspace("external", "external");
    const archived = { ...workspace("archived", "external"), archived: true };
    expect(selectableProjectWorkspaces([
      external,
      workspace("managed", "managed"),
      archived,
    ])).toEqual([external]);
  });
});
