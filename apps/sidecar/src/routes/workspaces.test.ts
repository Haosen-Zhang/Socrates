import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
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

  it("renames, archives, and only unregisters a project without touching its folder", async () => {
    const root = `${tmpdir()}/socrates-route-project-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const app = new Hono().route("/workspaces", workspaceRoutes(new WorkspaceManager(openDb(":memory:"))));
    const selected = await (await app.request("/workspaces", { method: "POST", body: JSON.stringify({ path: root }) })).json() as { id: string };

    const renamed = await app.request(`/workspaces/${selected.id}`, { method: "PUT", body: JSON.stringify({ label: "Research notes" }) });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).label).toBe("Research notes");

    const archived = await app.request(`/workspaces/${selected.id}/archive`, { method: "PUT", body: JSON.stringify({ archived: true }) });
    expect(archived.status).toBe(200);
    expect((await archived.json()).archived).toBe(true);

    const removed = await app.request(`/workspaces/${selected.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(existsSync(root)).toBe(true);
    expect(await (await app.request("/workspaces")).json()).toEqual([]);
  });
});
