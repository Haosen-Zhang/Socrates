import { Hono } from "hono";
import { z } from "zod";
import type { ProjectMemoryService } from "../services/project-memory";
export function projectMemoryRoutes(service: ProjectMemoryService) {
	const app = new Hono();
	app.onError((e, c) => c.json({ error: e.message }, 409));
	app.get("/:roomId", (c) =>
		c.json(service.list(c.req.param("roomId"), c.req.query("q"))),
	);
	app.post("/:roomId/save", async (c) => {
		const b = z
			.object({
				entry: z.unknown(),
				id: z.string().optional(),
				version: z.number().int().optional(),
				status: z
					.enum(["proposed", "confirmed", "superseded", "rejected", "expired"])
					.optional(),
			})
			.parse(await c.req.json());
		return c.json(service.save(c.req.param("roomId"), b.entry, b));
	});
	app.get("/:roomId/history/:id", (c) =>
		c.json(service.history(c.req.param("roomId"), c.req.param("id"))),
	);
	app.get("/:roomId/export", (c) =>
		c.json(service.export(c.req.param("roomId"))),
	);
	app.post("/:roomId/import-preview", async (c) =>
		c.json(service.preview(c.req.param("roomId"), await c.req.json())),
	);
	app.post("/:roomId/import", async (c) =>
		c.json(service.import(c.req.param("roomId"), await c.req.json())),
	);
	app.post("/:roomId/bind", async (c) => {
		const b = z
			.object({ sourceRoomId: z.string(), ids: z.array(z.string()).max(200) })
			.parse(await c.req.json());
		service.bind(c.req.param("roomId"), b.sourceRoomId, b.ids);
		return c.json({ ok: true });
	});
	app.get("/:roomId/tasks/:root", (c) =>
		c.json(service.manifests(c.req.param("roomId"), c.req.param("root"))),
	);
	app.post("/:roomId/propose-message", async (c) => {
		const b = z.object({ messageId: z.string() }).parse(await c.req.json());
		return c.json(service.proposeMessage(c.req.param("roomId"), b.messageId));
	});
	app.post("/:roomId/propose-task", async (c) => {
		const b = z.object({ rootTaskId: z.string() }).parse(await c.req.json());
		return c.json(service.proposeTask(c.req.param("roomId"), b.rootTaskId));
	});
	app.post("/:roomId/tasks/:root/refresh", (c) =>
		c.json(service.refresh(c.req.param("roomId"), c.req.param("root"))),
	);
	app.get("/:roomId/markdown", (c) =>
		c.text(
			service
				.list(c.req.param("roomId"))
				.map(
					(e) => `## ${e.kind} · ${e.status} · v${e.version}\n\n${e.content}\n`,
				)
				.join("\n"),
		),
	);
	app.get("/:roomId/binding", (c) =>
		c.json(service.binding(c.req.param("roomId"))),
	);
	app.get("/:roomId/sources", (c) =>
		c.json(service.sources(c.req.param("roomId"))),
	);
	return app;
}
