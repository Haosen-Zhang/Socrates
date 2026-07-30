import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { linkSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
});
