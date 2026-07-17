import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../db";
import { WorkspaceManager } from "../workspace/manager";
import { AttachmentResolver } from "./resolver";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("AttachmentResolver", () => {
  it("hashes, stores and deduplicates workspace files without persisting their source path", () => {
    const root = `${tmpdir()}/socrates-attachment-workspace-${crypto.randomUUID()}`;
    const data = `${tmpdir()}/socrates-attachment-data-${crypto.randomUUID()}`;
    roots.push(root, data);
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/note.txt`, "hello");
    const db = openDb(":memory:");
    const workspace = new WorkspaceManager(db).select(root);
    const resolver = new AttachmentResolver(db, data);
    const first = resolver.importWorkspaceFile(workspace, "note.txt");
    const second = resolver.importWorkspaceFile(workspace, "note.txt");
    expect(second.id).toBe(first.id);
    expect(resolver.belongsToWorkspace(first.id, workspace.id)).toBe(true);
    expect(resolver.read(first.id).bytes.toString()).toBe("hello");
    expect(JSON.stringify(db.query("SELECT * FROM attachments").get())).not.toContain(root);
  });

  it("detects image MIME by magic bytes and rejects truncation/secret paths", () => {
    const root = `${tmpdir()}/socrates-attachment-workspace-${crypto.randomUUID()}`;
    const data = `${tmpdir()}/socrates-attachment-data-${crypto.randomUUID()}`;
    roots.push(root, data);
    mkdirSync(root, { recursive: true });
    writeFileSync(`${root}/pixel.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
    writeFileSync(`${root}/.env`, "secret");
    const db = openDb(":memory:");
    const workspace = new WorkspaceManager(db).select(root);
    const resolver = new AttachmentResolver(db, data);
    expect(resolver.importWorkspaceFile(workspace, "pixel.png").mediaType).toBe("image/png");
    expect(() => resolver.importWorkspaceFile(workspace, ".env")).toThrow("workspace_secret_path_denied");
  });
});
