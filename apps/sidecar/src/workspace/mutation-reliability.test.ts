import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { inspectEntry } from "./mutation-evidence";
import { withPinnedWorkspaceParent } from "./native-fs";
import { WorkspacePathPolicy } from "./path-policy";

// Catches prefix-only hashes, ignored stale guards and truncation of the original inode.
describe("workspace mutation reliability", () => {
  let root: string;
  beforeEach(() => { root = `${tmpdir()}/socrates-reliable-${crypto.randomUUID()}`; mkdirSync(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("hashes the entire validated descriptor even when the preview is bounded", () => {
    writeFileSync(`${root}/a.txt`, "hello");
    expect(new WorkspacePathPolicy(root).readText("a.txt", 2)).toMatchObject({
      path: "a.txt", text: "he", truncated: true, byteSize: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    });
  });

  it("rejects a stale content guard without modifying the target", () => {
    writeFileSync(`${root}/a.txt`, "hello");
    const policy = new WorkspacePathPolicy(root);
    expect(() => policy.writeText("a.txt", "overwrite", { expectedSha256: "0".repeat(64) })).toThrow("WORKSPACE_FILE_CHANGED");
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("hello");
    expect(readdirSync(root)).toEqual(["a.txt"]);
  });

  it("atomically replaces an existing inode and preserves its permission bits", () => {
    writeFileSync(`${root}/a.txt`, "hello"); chmodSync(`${root}/a.txt`, 0o640);
    const inode = lstatSync(`${root}/a.txt`).ino;
    const result = new WorkspacePathPolicy(root).writeText("a.txt", "world\n");
    expect(lstatSync(`${root}/a.txt`).ino).not.toBe(inode);
    expect(lstatSync(`${root}/a.txt`).mode & 0o777).toBe(0o640);
    expect(result).toMatchObject({ existed: true, oldSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", diffTruncated: false });
    expect(result.diff).toContain("-hello"); expect(result.diff).toContain("+world");
  });

  it("verifies completed writes after loss of the tool result without replay", () => {
    const policy = new WorkspacePathPolicy(root);
    policy.writeText("a.txt", "hello", { operationId: "tool-write" });
    expect(policy.recoverMutation({ operationId: "tool-write", kind: "write", path: "a.txt" })).toMatchObject({ disposition: "verify_then_continue", outcome: "applied" });
    writeFileSync(`${root}/a.txt`, "user edit");
    expect(policy.recoverMutation({ operationId: "tool-write", kind: "write", path: "a.txt" }).outcome).toBe("unknown");
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("user edit");
  });

  it("does not modify files for a pre-aborted write", () => {
    writeFileSync(`${root}/a.txt`, "hello");
    expect(() => new WorkspacePathPolicy(root).writeText("a.txt", "new", { signal: AbortSignal.abort() })).toThrow();
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("hello");
  });
  it("recovers create, move and delete without replaying mutation bodies", () => {
    const policy = new WorkspacePathPolicy(root);
    policy.createFile("a.txt", Buffer.from("hello"), { operationId: "create-a" });
    expect(policy.recoverMutation({ operationId: "create-a", kind: "create", path: "a.txt" }).outcome).toBe("applied");
    policy.movePath("a.txt", "b.txt", { operationId: "move-a" });
    expect(policy.recoverMutation({ operationId: "move-a", kind: "move", path: "a.txt", destination: "b.txt" }).outcome).toBe("applied");
    policy.deletePath("b.txt", { operationId: "delete-b" });
    expect(policy.recoverMutation({ operationId: "delete-b", kind: "delete", path: "b.txt" }).outcome).toBe("applied");
    expect(existsSync(`${root}/b.txt`)).toBe(false);
  });

  it("recovers directory and tree creation while binding the requested content", () => {
    const policy = new WorkspacePathPolicy(root);
    policy.createDirectory("dir", { operationId: "mkdir" });
    expect(policy.recoverMutation({ operationId: "mkdir", kind: "create", path: "dir" }).outcome).toBe("applied");
    policy.createTree("tree", { kind: "directory", entries: [{ kind: "file", path: "a.txt", bytes: Buffer.from("hello") }], totalBytes: 5 }, { operationId: "tree" });
    expect(policy.recoverMutation({ operationId: "tree", kind: "create", path: "tree" }).outcome).toBe("applied");
    policy.writeText("other.txt", "hello", { operationId: "other" });
    expect(policy.recoverMutation({ operationId: "other", kind: "write", path: "other.txt", expectedNewSha256: "0".repeat(64) }).outcome).toBe("unknown");
  });

  it("bounds diff output and labels omitted large-file comparison", () => {
    const policy = new WorkspacePathPolicy(root);
    writeFileSync(`${root}/large.txt`, "before\n".repeat(20_000));
    const result = policy.writeText("large.txt", "after\n".repeat(20_000));
    expect(Buffer.byteLength(result.diff)).toBeLessThanOrEqual(16 * 1024);
    expect(result.diffTruncated).toBe(true);
    expect(readFileSync(`${root}/large.txt`, "utf8")).toBe("after\n".repeat(20_000));
  });

  it("hides mutation evidence from ordinary workspace access", () => {
    const policy = new WorkspacePathPolicy(root);
    policy.writeText("a.txt", "hello", { operationId: "hidden" });
    const journal = readdirSync(root).find((name) => name.startsWith(".socrates-op-"))!;
    expect(() => policy.readText(journal, 100)).toThrow("workspace_secret_path_denied");
    expect(policy.listDirectory(".", 100).entries.map((entry) => entry.name)).toEqual(["a.txt"]);
  });

  it("never mistakes a replacement symlink for an absent deleted target", () => {
    writeFileSync(`${root}/a.txt`, "hello");
    const policy = new WorkspacePathPolicy(root);
    policy.deletePath("a.txt", { operationId: "delete" });
    writeFileSync(`${root}/other.txt`, "user content");
    symlinkSync(`${root}/other.txt`, `${root}/a.txt`);
    expect(policy.recoverMutation({ operationId: "delete", kind: "delete", path: "a.txt" }).outcome).toBe("unknown");
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("user content");
  });

  it("distinguishes a no-follow symlink failure from an absent entry", () => {
    writeFileSync(`${root}/other.txt`, "user content");
    symlinkSync(`${root}/other.txt`, `${root}/a.txt`);
    expect(() => withPinnedWorkspaceParent(root, "a.txt", (fd, name) => inspectEntry(fd, name))).toThrow("workspace_symlink_denied");
  });

  it.each([["", "created"], ["hello", "world\n"], ["one\ntwo\n", "one\nthree\n"], ["hello", ""]])("returns a real applicable diff for %j to %j", (before, after) => {
    const policy = new WorkspacePathPolicy(root);
    writeFileSync(`${root}/a.txt`, before);
    const result = policy.writeText("a.txt", after);
    writeFileSync(`${root}/a.txt`, before);
    const applied = Bun.spawnSync({ cmd: ["/usr/bin/patch", "-p1", "--batch"], cwd: root, stdin: Buffer.from(result.diff) });
    expect(applied.exitCode).toBe(0);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe(after);
  });

});
