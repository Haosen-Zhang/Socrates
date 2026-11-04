import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WorkspacePathPolicy } from "./path-policy";

// Real child processes die after real fsync calls. Only the filesystem boundary
// is wrapped; staging, native publication, durable evidence and recovery are real.
function runFault(root: string, operation: string, boundary: string, attack = ""): number {
  const script = `
    import { mock } from "bun:test";
    import * as fs from "node:fs";
    const realSync = fs.fsyncSync;
    const root = process.argv[1];
    let directorySyncs = 0;
    let injected = false;
    mock.module("node:fs", () => ({ ...fs, fsyncSync(fd) {
      realSync(fd);
      const stat = fs.fstatSync(fd);
      if (stat.isDirectory()) directorySyncs++;
      const stageReady = stat.isFile() && stat.size === 7;
      const afterPublish = stat.isDirectory() && directorySyncs === 2;
      const afterEvidence = stat.isDirectory() && directorySyncs === 1;
      if (!injected && ((process.argv[3] === "stage" && stageReady) || (process.argv[3] === "publish" && afterPublish) || (process.argv[3] === "evidence" && afterEvidence))) {
        injected = true;
        const attack = process.argv[4];
        if (!attack) process.exit(77);
        if (attack === "edit") { fs.writeFileSync(root + "/a.txt", "user edit"); return; }
        if (attack === "stage-directory") {
          const stage = fs.readdirSync(root).find(name => name.startsWith(".socrates-stage-"));
          fs.renameSync(root + "/" + stage, root + "/original-stage");
          fs.mkdirSync(root + "/" + stage);
          fs.writeFileSync(root + "/" + stage + "/keep.txt", "user content");
          return;
        }
        if (attack === "journal") {
          const journal = fs.readdirSync(root).find(name => name.startsWith(".socrates-op-"));
          fs.renameSync(root + "/" + journal, root + "/original-journal");
          fs.writeFileSync(root + "/" + journal, "user journal replacement");
          return;
        }
        fs.renameSync(root + "/a.txt", root + "/original.txt");
        if (attack === "inode") fs.writeFileSync(root + "/a.txt", "user edit");
        if (attack === "symlink") fs.symlinkSync(root + "/outside.txt", root + "/a.txt");
        if (attack === "hardlink") fs.linkSync(root + "/outside.txt", root + "/a.txt");
      }
    }}));
    if (["swap", "swap-crash", "move-boundary", "create-boundary"].includes(process.argv[3])) {
      const native = await import(${JSON.stringify(new URL("./native-fs.ts", import.meta.url).pathname)});
      const realSwap = native.swapPinnedWorkspaceEntries;
      const realMove = native.renamePinnedWorkspaceEntryExclusiveBetween;
      const realRename = native.renamePinnedWorkspaceEntryExclusive;
      const injectSource = () => {
        if (injected) return;
        injected = true;
        fs.renameSync(root + "/a.txt", root + "/original.txt");
        if (process.argv[4] === "inode") fs.writeFileSync(root + "/a.txt", "user edit");
        if (process.argv[4] === "symlink") fs.symlinkSync(root + "/outside.txt", root + "/a.txt");
        if (process.argv[4] === "hardlink") fs.linkSync(root + "/outside.txt", root + "/a.txt");
      };
      mock.module(${JSON.stringify(new URL("./native-fs.ts", import.meta.url).pathname)}, () => ({ ...native, swapPinnedWorkspaceEntries(...args) {
        if (!injected) {
          injected = true;
          fs.renameSync(root + "/a.txt", root + "/original.txt");
          if (process.argv[4] === "inode") fs.writeFileSync(root + "/a.txt", "user edit");
          if (process.argv[4] === "symlink") fs.symlinkSync(root + "/outside.txt", root + "/a.txt");
          if (process.argv[4] === "hardlink") fs.linkSync(root + "/outside.txt", root + "/a.txt");
        }
        const result = realSwap(...args);
        if (process.argv[3] === "swap-crash") process.exit(77);
        return result;
      }, renamePinnedWorkspaceEntryExclusive(...args) {
        if (!injected && process.argv[3] === "create-boundary" && args[1].startsWith(".socrates-stage-")) {
          injected = true;
          const stage = root + "/" + args[1];
          fs.renameSync(stage, root + "/original-stage");
          if (process.argv[4] === "inode") fs.writeFileSync(stage, "user edit");
          if (process.argv[4] === "symlink") fs.symlinkSync(root + "/outside.txt", stage);
          if (process.argv[4] === "hardlink") fs.linkSync(root + "/outside.txt", stage);
        }
        return realRename(...args);
      }, renamePinnedWorkspaceEntryExclusiveBetween(...args) {
        if (process.argv[3] === "move-boundary") injectSource();
        return realMove(...args);
      }}));
    }
    const { WorkspacePathPolicy } = await import(${JSON.stringify(new URL("./path-policy.ts", import.meta.url).pathname)});
    const policy = new WorkspacePathPolicy(root);
    try {
      const options = process.argv[4] === "journal" ? {} : { operationId: "interrupted" };
      if (process.argv[2] === "write") policy.writeText("a.txt", "newtext", options);
      if (process.argv[2] === "create") policy.createFile("a.txt", Buffer.from("newtext"), options);
      if (process.argv[2] === "delete") policy.deletePath("a.txt", options);
      if (process.argv[2] === "tree") policy.createTree("a.txt", {kind: "directory", entries: [{kind: "file", path: "nested/new.txt", bytes: Buffer.from("newtext")}], totalBytes: 7}, options);
      if (process.argv[2] === "move") policy.movePath("a.txt", "b.txt", options);
    } catch (error) { process.stderr.write(String(error)); process.exit(78); }
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script, root, operation, boundary, attack]);
  if (![0, 77, 78].includes(child.exitCode)) throw new Error(child.stderr.toString());
  return child.exitCode;
}

describe("workspace crash and substitution boundaries", () => {
  let root: string;
  beforeEach(() => { root = `${tmpdir()}/socrates-fault-${crypto.randomUUID()}`; mkdirSync(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(["write", "create"])("preserves prepublication state after interrupted %s staging", (kind) => {
    if (kind === "write") writeFileSync(`${root}/a.txt`, "oldtext");
    expect(runFault(root, kind, "stage")).toBe(77);
    expect(existsSync(`${root}/a.txt`)).toBe(kind === "write");
    if (kind === "write") expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("oldtext");
    const policy = new WorkspacePathPolicy(root);
    expect(policy.recoverMutation({ operationId: "interrupted", kind: kind as "write" | "create", path: "a.txt" }).outcome).toBe("not_applied");
    expect(readdirSync(root).some((name) => name.startsWith(".socrates-stage-"))).toBe(true);
  });

  it.each(["write", "create"])("verifies published %s after process death before its return", (kind) => {
    if (kind === "write") writeFileSync(`${root}/a.txt`, "oldtext");
    expect(runFault(root, kind, "publish")).toBe(77);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("newtext");
    expect(new WorkspacePathPolicy(root).recoverMutation({ operationId: "interrupted", kind: kind as "write" | "create", path: "a.txt" }).outcome).toBe("applied");
  });

  it("preserves a quarantined deletion after process death without retrying unlink", () => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    expect(runFault(root, "delete", "publish")).toBe(77);
    expect(existsSync(`${root}/a.txt`)).toBe(false);
    expect(new WorkspacePathPolicy(root).recoverMutation({ operationId: "interrupted", kind: "delete", path: "a.txt" }).outcome).toBe("applied");
    expect(readdirSync(root).some((name) => name.startsWith(".socrates-stage-"))).toBe(true);
  });

  it("verifies a moved inode after process death at destination directory fsync", () => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    expect(runFault(root, "move", "publish")).toBe(77);
    expect(existsSync(`${root}/a.txt`)).toBe(false);
    expect(readFileSync(`${root}/b.txt`, "utf8")).toBe("oldtext");
    expect(new WorkspacePathPolicy(root).recoverMutation({ operationId: "interrupted", kind: "move", path: "a.txt", destination: "b.txt" }).outcome).toBe("applied");
  });

  it.each(["inode", "symlink", "hardlink"])("refuses a %s substituted while staging without touching either original", (attack) => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    writeFileSync(`${root}/outside.txt`, "outside");
    expect(runFault(root, "write", "stage", attack)).toBe(78);
    expect(readFileSync(`${root}/original.txt`, "utf8")).toBe("oldtext");
    expect(readFileSync(`${root}/outside.txt`, "utf8")).toBe("outside");
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe(attack === "inode" ? "user edit" : "outside");
  });
  it.each(["inode", "symlink", "hardlink"])("restores a %s substituted at the atomic exchange boundary", (attack) => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    writeFileSync(`${root}/outside.txt`, "outside");
    expect(runFault(root, "write", "swap", attack)).toBe(78);
    expect(readFileSync(`${root}/original.txt`, "utf8")).toBe("oldtext");
    expect(readFileSync(`${root}/outside.txt`, "utf8")).toBe("outside");
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe(attack === "inode" ? "user edit" : "outside");
  });

  it("preserves a substituted evidence name during postpublication cleanup", () => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    expect(runFault(root, "write", "publish", "journal")).toBe(78);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("newtext");
    const names = readdirSync(root);
    expect(names.some((name) => name.startsWith(".socrates-op-") && readFileSync(`${root}/${name}`, "utf8") === "user journal replacement")).toBe(true);
    expect(existsSync(`${root}/original-journal`)).toBe(true);
  });

  it("never writes into or cleans a substituted staging directory", () => {
    writeFileSync(`${root}/a.txt`, "occupied");
    expect(runFault(root, "tree", "evidence", "stage-directory")).toBe(78);
    const stage = readdirSync(root).find((name) => name.startsWith(".socrates-stage-"))!;
    expect(stage).toBeDefined();
    expect(readFileSync(`${root}/${stage}/keep.txt`, "utf8")).toBe("user content");
    expect(existsSync(`${root}/${stage}/nested/new.txt`)).toBe(false);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("occupied");
  });

  it("restores a deletion target edited on the same inode after evidence capture", () => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    expect(runFault(root, "delete", "evidence", "edit")).toBe(78);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("user edit");
  });

  it.each(["inode", "symlink", "hardlink"])("restores a %s substituted at the move boundary", (attack) => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    writeFileSync(`${root}/outside.txt`, "outside");
    expect(runFault(root, "move", "move-boundary", attack)).toBe(78);
    expect(existsSync(`${root}/b.txt`)).toBe(false);
    expect(readFileSync(`${root}/original.txt`, "utf8")).toBe("oldtext");
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe(attack === "inode" ? "user edit" : "outside");
  });

  it("does not certify a write that died after exchanging a substituted inode", () => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    writeFileSync(`${root}/outside.txt`, "outside");
    expect(runFault(root, "write", "swap-crash", "inode")).toBe(77);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("newtext");
    const policy = new WorkspacePathPolicy(root);
    expect(policy.recoverMutation({ operationId: "interrupted", kind: "write", path: "a.txt" }).outcome).toBe("unknown");
    expect(readFileSync(`${root}/original.txt`, "utf8")).toBe("oldtext");
  });

  it.each(["delete", "move"])("reports no effect when %s dies after durable intent before publication", (kind) => {
    writeFileSync(`${root}/a.txt`, "oldtext");
    expect(runFault(root, kind, "evidence")).toBe(77);
    expect(readFileSync(`${root}/a.txt`, "utf8")).toBe("oldtext");
    expect(new WorkspacePathPolicy(root).recoverMutation({ operationId: "interrupted", kind: kind as "delete" | "move", path: "a.txt", ...(kind === "move" ? {destination: "b.txt"} : {}) }).outcome).toBe("not_applied");
  });

  it.each(["inode", "symlink", "hardlink"])("does not publish a %s substituted for the completed create stage", (attack) => {
    writeFileSync(`${root}/outside.txt`, "outside");
    expect(runFault(root, "create", "create-boundary", attack)).toBe(78);
    expect(existsSync(`${root}/a.txt`)).toBe(false);
    expect(readFileSync(`${root}/original-stage`, "utf8")).toBe("newtext");
    expect(readFileSync(`${root}/outside.txt`, "utf8")).toBe("outside");
  });

});
