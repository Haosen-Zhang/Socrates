import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { AttachmentResolver } from "../attachments/resolver";
import { openDb } from "../db";
import { WorkspaceManager } from "../workspace/manager";
import { contentRoutes } from "./content";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("content routes", () => {
  it("returns bounded tracked and untracked Git changes without accepting paths outside the workspace", async () => {
    const root = `${tmpdir()}/socrates-content-git-${crypto.randomUUID()}`;
    const data = `${tmpdir()}/socrates-content-git-data-${crypto.randomUUID()}`;
    const plainRoot = `${tmpdir()}/socrates-content-not-git-${crypto.randomUUID()}`;
    roots.push(root, data, plainRoot);
    mkdirSync(root, { recursive: true });
    mkdirSync(plainRoot, { recursive: true });
    writeFileSync(`${root}/tracked.ts`, "export const value = 1;\n");
    const runGit = (...argv: string[]) => execFileSync("/usr/bin/git", argv, { cwd: root, stdio: "ignore" });
    runGit("init");
    runGit("config", "user.name", "Socrates Test");
    runGit("config", "user.email", "socrates@example.invalid");
    runGit("add", "tracked.ts");
    runGit("commit", "-m", "initial");
    writeFileSync(`${root}/tracked.ts`, "export const value = 2;\n");
    writeFileSync(`${root}/draft.md`, "draft\n");

    const db = openDb(":memory:");
    const manager = new WorkspaceManager(db);
    const workspace = manager.select(root);
    const plain = manager.select(plainRoot);
    const app = new Hono().route("/content", contentRoutes(db, manager, new AttachmentResolver(db, data)));

    expect(await (await app.request(`/content/workspaces/${workspace.id}/git/status`)).json()).toEqual({
      state: "ready",
      files: [
        { relativePath: "draft.md", status: "untracked" },
        { relativePath: "tracked.ts", status: "modified" },
      ],
      truncated: false,
    });
    const tracked = await (await app.request(`/content/workspaces/${workspace.id}/git/diff?path=tracked.ts`)).json();
    expect(tracked).toMatchObject({ relativePath: "tracked.ts", binary: false, truncated: false });
    expect(tracked.patch).toContain("-export const value = 1;");
    expect(tracked.patch).toContain("+export const value = 2;");
    const untracked = await (await app.request(`/content/workspaces/${workspace.id}/git/diff?path=draft.md`)).json();
    expect(untracked.patch).toContain("new file mode");
    expect(untracked.patch).toContain("+draft");
    writeFileSync(`${root}/large.txt`, "x".repeat(2 * 1024 * 1024 + 32_000));
    const bounded = await (await app.request(`/content/workspaces/${workspace.id}/git/diff?path=large.txt`)).json();
    expect(bounded.truncated).toBe(true);
    expect(Buffer.byteLength(bounded.patch, "utf8")).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect((await app.request(`/content/workspaces/${workspace.id}/git/diff?path=..%2Foutside`)).status).toBe(400);
    expect(await (await app.request(`/content/workspaces/${plain.id}/git/status`)).json()).toEqual({
      state: "not_git",
      files: [],
      truncated: false,
    });
  });

  it("lists and previews workspace files lazily without exposing secrets or nested contents", async () => {
    const root = `${tmpdir()}/socrates-content-browser-${crypto.randomUUID()}`;
    const data = `${tmpdir()}/socrates-content-browser-data-${crypto.randomUUID()}`;
    roots.push(root, data);
    mkdirSync(`${root}/src/nested`, { recursive: true });
    writeFileSync(`${root}/README.md`, "# Hello\n");
    writeFileSync(`${root}/src/index.ts`, "export const answer = 42;\n");
    writeFileSync(`${root}/src/nested/deep.ts`, "hidden until expanded");
    writeFileSync(`${root}/.env`, "SECRET=never");
    mkdirSync(`${root}/crowded`);
    for (let index = 0; index < 501; index += 1) writeFileSync(`${root}/crowded/file-${index}.txt`, "x");
    const db = openDb(":memory:");
    const manager = new WorkspaceManager(db);
    const workspace = manager.select(root);
    const app = new Hono().route("/content", contentRoutes(db, manager, new AttachmentResolver(db, data)));

    expect(await (await app.request(`/content/workspaces/${workspace.id}/tree`)).json()).toEqual({
      path: "",
      entries: [
        { name: "crowded", relativePath: "crowded", kind: "directory" },
        { name: "src", relativePath: "src", kind: "directory" },
        { name: "README.md", relativePath: "README.md", kind: "file" },
      ],
      truncated: false,
    });
    expect(await (await app.request(`/content/workspaces/${workspace.id}/tree?path=src`)).json()).toEqual({
      path: "src",
      entries: [
        { name: "nested", relativePath: "src/nested", kind: "directory" },
        { name: "index.ts", relativePath: "src/index.ts", kind: "file" },
      ],
      truncated: false,
    });
    const crowded = await (await app.request(`/content/workspaces/${workspace.id}/tree?path=crowded`)).json();
    expect(crowded.entries).toHaveLength(500);
    expect(crowded.truncated).toBe(true);
    expect(await (await app.request(`/content/workspaces/${workspace.id}/file?path=src%2Findex.ts`)).json()).toEqual({
      relativePath: "src/index.ts",
      text: "export const answer = 42;\n",
      byteSize: 26,
      truncated: false,
    });
    expect((await app.request(`/content/workspaces/${workspace.id}/file?path=..%2Foutside`)).status).toBe(400);
  });

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
