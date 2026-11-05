import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { openDb } from "../db";
import { AttachmentResolver } from "../attachments/resolver";
import { WorkspaceManager } from "../workspace/manager";
import { contentRoutes } from "../routes/content";
import { resolveRoomFileContext } from "./room-file-context";

test("discussion file and directory context uses frozen scoped reference content", async () => {
  const root = mkdtempSync(`${tmpdir()}/socrates-public-context-`), db = openDb(":memory:");
  try {
    mkdirSync(`${root}/src`); writeFileSync(`${root}/src/a.ts`, "export const value = 7;");
    const workspaces = new WorkspaceManager(db), workspace = workspaces.select(root);
    const attachments = new AttachmentResolver(db, `${root}/data`);
    const app = new Hono().route("/content", contentRoutes(db, workspaces, attachments));
    const ref = await (await app.request(`/content/workspaces/${workspace.id}/refs`, { method: "POST", body: JSON.stringify({ relativePath: "src/a.ts" }) })).json();
    const directory = await (await app.request(`/content/workspaces/${workspace.id}/refs`, { method: "POST", body: JSON.stringify({ relativePath: "src" }) })).json();
    expect(directory.kind).toBe("directory");
    const context = resolveRoomFileContext(db, workspaces, attachments, workspace.id, [ref.id, directory.id], []);
    expect(context.text).toContain("export const value = 7;");
    expect(context.text).toContain("a.ts");
    expect(context.parts).toHaveLength(2);
    expect(() => resolveRoomFileContext(db, workspaces, attachments, null, [ref.id], [])).toThrow("file_context_workspace_required");
    writeFileSync(`${root}/src/a.ts`, "changed");
    expect(() => resolveRoomFileContext(db, workspaces, attachments, workspace.id, [ref.id], [])).toThrow("workspace_ref_stale");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
