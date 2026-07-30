import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorkspacePathPolicy } from "./path-policy";

describe("WorkspacePathPolicy", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = `${tmpdir()}/socrates-workspace-${crypto.randomUUID()}`;
    outside = `${tmpdir()}/socrates-outside-${crypto.randomUUID()}`;
    mkdirSync(`${root}/src`, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(`${root}/src/index.ts`, "export const safe = true;\n");
    writeFileSync(`${root}/.env`, "SECRET=nope\n");
    writeFileSync(`${outside}/secret.txt`, "outside\n");
    symlinkSync(`${outside}/secret.txt`, `${root}/src/link.txt`);
    linkSync(`${outside}/secret.txt`, `${root}/src/hardlink.txt`);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("resolves and reads a normal in-workspace file", () => {
    const policy = new WorkspacePathPolicy(root);
    expect(policy.resolveExisting("src/index.ts").relativePath).toBe("src/index.ts");
    expect(policy.readText("src/index.ts", 1_000).text).toContain("safe");
  });

  it("rejects traversal, absolute, secret and symlink paths", () => {
    const policy = new WorkspacePathPolicy(root);
    expect(() => policy.resolveExisting("../secret.txt")).toThrow("workspace_path_traversal");
    expect(() => policy.resolveExisting(`${outside}/secret.txt`)).toThrow("workspace_path_must_be_relative");
    expect(() => policy.readText(".env", 1_000)).toThrow("workspace_secret_path_denied");
    expect(() => policy.readText("src/link.txt", 1_000)).toThrow("workspace_symlink_denied");
    expect(() => policy.readText("src/hardlink.txt", 1_000)).toThrow("workspace_hardlink_denied");
  });

  it("bounds reads and refuses binary content", () => {
    writeFileSync(`${root}/large.txt`, "x".repeat(50));
    writeFileSync(`${root}/binary.dat`, new Uint8Array([1, 0, 2]));
    const policy = new WorkspacePathPolicy(root);
    expect(policy.readText("large.txt", 10)).toMatchObject({ truncated: true, byteSize: 50 });
    expect(() => policy.readText("binary.dat", 10)).toThrow("workspace_binary_file");
  });

  it("resolves new mutation targets through an existing non-symlink parent", () => {
    const policy = new WorkspacePathPolicy(root);
    expect(policy.resolveMutationTarget("src/new/nested.txt")).toEqual({
      absolutePath: `${policy.canonicalRoot}/src/new/nested.txt`,
      relativePath: "src/new/nested.txt",
    });
  });

  it("rejects mutation targets through symlinks, secrets, traversal, and the workspace root", () => {
    symlinkSync(outside, `${root}/linked-directory`);
    const policy = new WorkspacePathPolicy(root);
    expect(() => policy.resolveMutationTarget("linked-directory/new.txt")).toThrow("workspace_symlink_denied");
    expect(() => policy.resolveMutationTarget(".env")).toThrow("workspace_secret_path_denied");
    expect(() => policy.resolveMutationTarget("../outside.txt")).toThrow("workspace_path_traversal");
    expect(() => policy.resolveMutationTarget(".")).toThrow("workspace_root_mutation_denied");
  });

  it("writes through no-follow descriptors and rejects hardlink overwrites", () => {
    const policy = new WorkspacePathPolicy(root);
    expect(policy.writeText("src/new.txt", "new\n")).toEqual({
      relativePath: "src/new.txt",
      existed: false,
    });
    expect(policy.writeText("src/nested/deep.txt", "nested\n")).toEqual({
      relativePath: "src/nested/deep.txt",
      existed: false,
    });
    expect(policy.readText("src/nested/deep.txt", 100).text).toBe("nested\n");
    expect(policy.writeText("src/new.txt", "updated\n").existed).toBe(true);
    expect(policy.readText("src/new.txt", 100).text).toBe("updated\n");
    expect(statSync(`${root}/src/new.txt`).mode & 0o777).toBe(0o600);
    expect(() => policy.writeText("src/hardlink.txt", "overwrite\n")).toThrow("workspace_hardlink_denied");
  });

  it("creates directories and non-overwriting binary files through pinned descriptors", () => {
    const policy = new WorkspacePathPolicy(root);
    expect(policy.createDirectory("exports/reports")).toEqual({ path: "exports/reports" });
    expect(policy.createFile("exports/report.bin", Buffer.from([1, 2, 3]))).toEqual({
      path: "exports/report.bin",
      byteSize: 3,
    });
    expect(readFileSync(`${root}/exports/report.bin`)).toEqual(Buffer.from([1, 2, 3]));
    expect(() => policy.createFile("exports/report.bin", Buffer.from([4]))).toThrow("workspace_path_changed");
    expect(readdirSync(`${root}/exports`).filter((name) => name.startsWith(".socrates-"))).toEqual([]);
  });

  it("takes a bounded snapshot of a directory without following links or hardlinks", () => {
    mkdirSync(`${root}/tree/empty`, { recursive: true });
    writeFileSync(`${root}/tree/a.txt`, "alpha");
    const policy = new WorkspacePathPolicy(root);
    expect(policy.snapshotTree("tree", { maxEntries: 10, maxBytes: 100 })).toEqual({
      kind: "directory",
      entries: [
        { kind: "file", path: "a.txt", bytes: Buffer.from("alpha") },
        { kind: "directory", path: "empty" },
      ],
      totalBytes: 5,
    });
    expect(() => policy.snapshotTree("src", { maxEntries: 10, maxBytes: 100 }))
      .toThrow(/workspace_(symlink|hardlink)_denied/);
    expect(() => policy.snapshotTree("tree", { maxEntries: 1, maxBytes: 100 }))
      .toThrow("workspace_tree_too_many_entries");
    expect(() => policy.snapshotTree("tree/a.txt", { maxEntries: 0, maxBytes: 100 }))
      .toThrow("workspace_tree_too_many_entries");
  });

  it("moves files and directories without overwrite and rejects moving a directory into itself", () => {
    mkdirSync(`${root}/move-me/nested`, { recursive: true });
    writeFileSync(`${root}/move-me/nested/file.txt`, "content");
    writeFileSync(`${root}/occupied.txt`, "keep");
    const policy = new WorkspacePathPolicy(root);

    expect(policy.movePath("move-me", "renamed")).toEqual({
      from: "move-me",
      to: "renamed",
      kind: "directory",
    });
    expect(existsSync(`${root}/move-me`)).toBe(false);
    expect(readFileSync(`${root}/renamed/nested/file.txt`, "utf-8")).toBe("content");
    expect(() => policy.movePath("renamed", "occupied.txt")).toThrow("workspace_path_changed");
    expect(() => policy.movePath("renamed", "renamed/inside")).toThrow("workspace_move_into_self");
  });

  it("publishes copied trees atomically and cleans staging after a destination collision", () => {
    mkdirSync(`${root}/copy-source/nested`, { recursive: true });
    writeFileSync(`${root}/copy-source/nested/file.txt`, "content");
    mkdirSync(`${root}/occupied`);
    const policy = new WorkspacePathPolicy(root);
    const snapshot = policy.snapshotTree("copy-source", { maxEntries: 10, maxBytes: 100 });

    expect(() => policy.createTree("occupied", snapshot)).toThrow("workspace_path_changed");
    expect(readdirSync(root).filter((name) => name.startsWith(".socrates-tree-"))).toEqual([]);
    expect(readdirSync(`${root}/occupied`)).toEqual([]);
  });
});
