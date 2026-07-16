import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../db";
import { WorkspaceManager } from "./manager";

const paths: string[] = [];
afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("WorkspaceManager", () => {
  it("canonicalizes aliases into one durable identity and recent entry", () => {
    const root = `${tmpdir()}/socrates-workspace-manager-${crypto.randomUUID()}`;
    paths.push(root);
    mkdirSync(root, { recursive: true });
    const manager = new WorkspaceManager(openDb(":memory:"));
    const first = manager.select(root);
    const second = manager.select(`${root}/.`);
    expect(second.id).toBe(first.id);
    expect(manager.listRecent()).toHaveLength(1);
  });

  it("rejects missing paths and files", () => {
    const root = `${tmpdir()}/socrates-workspace-file-${crypto.randomUUID()}`;
    paths.push(root);
    writeFileSync(root, "file");
    const manager = new WorkspaceManager(openDb(":memory:"));
    expect(() => manager.select(`${root}-missing`)).toThrow("workspace_not_found");
    expect(() => manager.select(root)).toThrow("workspace_not_directory");
  });
});
