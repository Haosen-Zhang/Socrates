import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { AttachmentResolver } from "../attachments/resolver";
import { openDb } from "../db";
import { WorkspaceManager } from "../workspace/manager";
import { contentRoutes } from "./content";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("content routes", () => {
  it("searches, creates refs, imports and serves attachment bytes", async () => {
    const root = `${tmpdir()}/socrates-content-workspace-${crypto.randomUUID()}`;
    const data = `${tmpdir()}/socrates-content-data-${crypto.randomUUID()}`;
    roots.push(root, data);
    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/note.txt`, "hello");
    const db = openDb(":memory:");
    const manager = new WorkspaceManager(db);
    const workspace = manager.select(root);
    const app = new Hono().route("/content", contentRoutes(db, manager, new AttachmentResolver(db, data)));
    expect(await (await app.request(`/content/workspaces/${workspace.id}/files?q=note`)).json()).toEqual([{ relativePath: "src/note.txt", kind: "file" }]);
    const firstRef = await app.request(`/content/workspaces/${workspace.id}/refs`, { method: "POST", body: JSON.stringify({ relativePath: "src/note.txt" }) });
    expect(firstRef.status).toBe(201);
    const firstRefBody = await firstRef.json();
    writeFileSync(`${root}/src/note.txt`, "hello again");
    const refreshedRef = await (await app.request(`/content/workspaces/${workspace.id}/refs`, { method: "POST", body: JSON.stringify({ relativePath: "src/note.txt" }) })).json();
    expect(refreshedRef.id).toBe(firstRefBody.id);
    expect(refreshedRef.snapshotHash).not.toBe(firstRefBody.snapshotHash);
    writeFileSync(`${root}/src/note.txt`, "hello");
    const attachment = await (await app.request("/content/attachments/import", { method: "POST", body: JSON.stringify({ workspaceId: workspace.id, relativePath: "src/note.txt" }) })).json();
    const bytes = await app.request(`/content/attachments/${attachment.id}`);
    expect(bytes.headers.get("content-type")).toBe("text/plain");
    expect(bytes.headers.get("content-disposition")).toStartWith("attachment;");
    expect(bytes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await bytes.text()).toBe("hello");

    const pasted = await (await app.request(`/content/attachments/upload?workspaceId=${workspace.id}&filename=pasted.txt`, {
      method: "POST",
      body: "from clipboard",
    })).json();
    expect(pasted.mediaType).toBe("text/plain");
    expect(new AttachmentResolver(db, data).belongsToWorkspace(pasted.id, workspace.id)).toBe(true);
  });
});
