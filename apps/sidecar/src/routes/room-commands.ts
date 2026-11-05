import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { RoomCommandInput } from "@socrates/core";
import type { RoomCommandService } from "../services/room-command-service";

export function roomCommandRoutes(commands: RoomCommandService): Hono {
  const app = new Hono();
  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.roomId !== "string" || typeof body.content !== "string" || typeof body.clientRequestId !== "string" || !Array.isArray(body.mentions)
      || body.mentions.some((m: unknown) => !m || typeof m !== "object")
      || [body.attachmentIds, body.workspaceRefIds].some((ids) => ids !== undefined && (!Array.isArray(ids) || ids.some((id: unknown) => typeof id !== "string")))) {
      return c.json({ error: "invalid_room_command" }, 400);
    }
    try { return c.json(await commands.submit(body as RoomCommandInput), 202); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "room_command_failed" }, 409); }
  });
  app.get("/rooms/:roomId", (c) => c.json(commands.list(c.req.param("roomId"))));
  app.get("/:id", (c) => { const command = commands.get(c.req.param("id")); return command ? c.json(command) : c.json({ error: "command_not_found" }, 404); });
  app.post("/:id/cancel", async (c) => {
    try { await commands.cancel(c.req.param("id")); return c.json({ ok: true }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : "cancel_failed" }, 409); }
  });
  app.get("/:id/events", (c) => {
    const id = c.req.param("id");
    const command = commands.get(id);
    if (!command) return c.json({ error: "command_not_found" }, 404);
    if (command.status === "revoked") return c.json({ error: "room_command_revoked" }, 410);
    const rawCursor = c.req.query("afterSeq") ?? "0";
    if (!/^(0|[1-9]\d*)$/.test(rawCursor) || !Number.isSafeInteger(Number(rawCursor))) return c.json({ error: "invalid_event_cursor" }, 400);
    return streamSSE(c, async (stream) => {
      let cursor = Number(rawCursor);
      while (!c.req.raw.signal.aborted && !stream.aborted) {
        const pending = commands.eventsAfter(id, cursor);
        for (const event of pending) {
          if (commands.get(id)?.status === "revoked") return;
          await stream.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) }); cursor = event.seq;
        }
        // Drain persisted pages even when the task is already terminal.
        if (pending.length === 500) continue;
        const current = commands.get(id);
        if (!current || current.status === "revoked") return;
        const keepOpen = current.kind === "team"
          ? commands.isSettling(id) || !["completed", "failed", "cancelled", "interrupted"].includes(current.status)
          : ["dispatching", "running"].includes(current.status);
        if (!keepOpen) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });
  });
  return app;
}
