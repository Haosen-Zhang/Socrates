import { arenaExport, arenaCsv } from "../services/arena-export";
import { Hono } from "hono";
import type { ArenaService } from "../services/arena-service";
export function arenaRoutes(service: ArenaService) {
	const app = new Hono();
	app.onError((e, c) => c.json({ error: e.message }, 409));
	app.get("/rooms/:roomId/templates", (c) =>
		c.json(service.templates(c.req.param("roomId"))),
	);
	app.get("/rooms/:roomId", (c) => c.json(service.list(c.req.param("roomId"))));
	app.get("/experiments/:id", (c) =>
		c.json(service.results(c.req.param("id"))),
	);
	app.post("/experiments", async (c) => {
		if (Number(c.req.header("Content-Length") ?? 0) > 256000)
			return c.json({ error: "arena_definition_too_large" }, 413);
		return c.json(service.prepare(await c.req.json()), 201);
	});
	app.post("/experiments/:id/cleanup", async (c) => {
		const body = await c.req.json();
		return c.json(service.cleanup(c.req.param("id"), body.confirmed === true));
	});
	app.post("/experiments/:id/start", (c) =>
		c.json(service.start(c.req.param("id")), 202),
	);
	app.post("/experiments/:id/cancel", async (c) =>
		c.json(await service.cancel(c.req.param("id"))),
	);
	app.post("/experiments/:id/trials/:trialId/cancel", async (c) =>
		c.json(await service.cancel(c.req.param("id"), c.req.param("trialId"))),
	);
	app.get("/experiments/:id/export", (c) => {
		const safe = arenaExport(service.results(c.req.param("id")));
		return c.json({
			schemaVersion: 1,
			kind: "socrates-arena-results",
			...safe.data,
			exportRedacted: safe.redacted,
		});
	});
	app.get("/experiments/:id/export.csv", (c) =>
		c.text(
			arenaCsv(arenaExport(service.results(c.req.param("id"))).data.trials),
		),
	);
	app.get("/experiments/:id/export.jsonl", (c) =>
		c.text(
			arenaExport(service.results(c.req.param("id")))
				.data.trials.map((t) => JSON.stringify(t))
				.join("\n"),
		),
	);
	return app;
}
