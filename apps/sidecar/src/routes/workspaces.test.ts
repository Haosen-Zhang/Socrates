import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { openDb } from "../db";
import { WorkspaceManager } from "../workspace/manager";
import { workspaceRoutes } from "./workspaces";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("workspace routes", () => {
  it("selects and lists a canonical workspace", async () => {
    const root = `${tmpdir()}/socrates-route-workspace-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const app = new Hono().route("/workspaces", workspaceRoutes(new WorkspaceManager(openDb(":memory:"))));
    const selected = await app.request("/workspaces", { method: "POST", body: JSON.stringify({ path: root }) });
    expect(selected.status).toBe(201);
    expect((await selected.json()).canonicalPath).toBe(realpathSync(root));
    expect(await (await app.request("/workspaces")).json()).toHaveLength(1);
  });
});
