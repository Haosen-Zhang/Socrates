import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { JsonlChildSupervisor } from "../child-supervisor";
import { CodexProtocolClient, validateCodexRuntimeOptions } from "./protocol-client";

const fixture = resolve(import.meta.dir, "fixtures/fake-app-server.ts");

describe("CodexProtocolClient", () => {
  it("rejects unsafe sandbox/reviewer combinations", () => {
    expect(() => validateCodexRuntimeOptions({ sandbox: "danger-full-access" as never, approvalsReviewer: "user" })).toThrow("codex_unsafe_sandbox");
    expect(() => validateCodexRuntimeOptions({ sandbox: "workspace-write", approvalsReviewer: "auto_review" as never })).toThrow("codex_unsafe_approval_reviewer");
  });

  it("initializes, starts a bounded thread/turn and interrupts", async () => {
    const supervisor = new JsonlChildSupervisor([process.execPath, fixture, "normal"]);
    const client = new CodexProtocolClient(supervisor, async () => "decline");
    await client.initialize();
    const thread = await client.startThread({ cwd: "/tmp", sandbox: "read-only", model: "fake" });
    expect(thread.thread.id).toBe("thread-1");
    const turn = await client.startTurn(thread.thread.id, "Read only");
    expect(turn.turn.id).toBe("turn-1");
    await client.interrupt(thread.thread.id, turn.turn.id);
    await client.close();
  });
});
