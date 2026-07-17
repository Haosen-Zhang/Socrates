import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { buildChildEnvironment, JsonlChildSupervisor } from "./child-supervisor";

const fixture = resolve(import.meta.dir, "codex/fixtures/fake-app-server.ts");
const child = (mode: string) => new JsonlChildSupervisor([process.execPath, fixture, mode], { requestTimeoutMs: 200 });

describe("JsonlChildSupervisor", () => {
  it("does not inherit provider keys or arbitrary environment variables", () => {
    expect(buildChildEnvironment({ PATH: "/bin", HOME: "/home", OPENAI_API_KEY: "secret", RANDOM_SECRET: "secret" })).toEqual({ PATH: "/bin", HOME: "/home" });
  });
  it("correlates responses, notifications and server approval requests", async () => {
    const supervisor = child("normal");
    const notifications: string[] = [];
    supervisor.onNotification((message) => notifications.push(message.method));
    supervisor.onServerRequest(async (message) => ({ decision: message.method.includes("commandExecution") ? "decline" : "cancel" }));
    await supervisor.start();
    expect(await supervisor.request("initialize", { clientInfo: { name: "test", version: "1" } })).toMatchObject({ userAgent: "fake/1" });
    expect(await supervisor.request("echo", { hello: true })).toEqual({ hello: true });
    expect(notifications).toEqual(["fake/progress"]);
    expect(await supervisor.request("approval", {})).toEqual({ approved: { decision: "decline" } });
    await supervisor.close();
  });

  it("fails pending work on timeout, malformed output and crash", async () => {
    for (const [mode, message] of [["hang", "protocol_request_timeout"], ["malformed", "protocol_malformed_json"], ["crash", "protocol_child_exited"]] as const) {
      const supervisor = child(mode);
      await supervisor.start();
      await expect(supervisor.request("initialize", {})).rejects.toThrow(message);
      await supervisor.close();
    }
  });
});
