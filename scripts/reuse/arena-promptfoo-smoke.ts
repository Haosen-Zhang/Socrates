import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCostFlowFixture } from "../../apps/sidecar/src/services/cost-flow-fixture";
import { ArenaService } from "../../apps/sidecar/src/services/arena-service";
const configDir = mkdtempSync(join(tmpdir(), "socrates-arena-promptfoo-"));
Object.assign(process.env, {
	PROMPTFOO_CONFIG_DIR: configDir,
	PROMPTFOO_DISABLE_TELEMETRY: "true",
	PROMPTFOO_DISABLE_UPDATE: "true",
	PROMPTFOO_DISABLE_SHARING: "true",
	PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: "true",
	IS_TESTING: "true",
});
const priorFetch = globalThis.fetch;
globalThis.fetch = (async () => {
	throw new Error("arena_external_network_forbidden");
}) as typeof fetch;
const f = await setupCostFlowFixture({ routingFixture: true });
const service = new ArenaService(f.db, {
	...f,
	baseDirectory: join(f.directory, "arena"),
	controlled: true,
});
try {
	const collaboration = structuredClone(
		f.sessions.get(f.roomIds.work)!.collaboration,
	);
	collaboration.strategy = "single";
	collaboration.assignment.routing.mode = "manual";
	collaboration.assignment.routing.lightweightAgentId = "fixture-a";
	const experiment = service.prepare({
		schemaVersion: 1,
		roomId: f.roomIds.work,
		requestId: "promptfoo",
		label: "Controlled full task",
		datasetVersion: "offline-v1",
		files: ["context.txt"],
		tasks: [
			{
				id: "task",
				category: "simple-fix",
				prompt: "Create controlled result",
				checks: [
					{
						id: "exists",
						label: "Independent artifact",
						kind: "file",
						path: "result.txt",
						required: true,
						origin: "user",
					},
				],
				artifactPaths: ["result.txt"],
				protectedPaths: [],
			},
		],
		variants: [
			{
				id: "A",
				label: "Fixture executor",
				primaryAgentId: "fixture-a",
				collaboration,
			},
		],
		repeats: 1,
		concurrency: 1,
		timeoutMs: 10000,
		groupBudgetAtomic: "1000000000000000",
		trialBudgetAtomic: "1000000000000000",
		mode: "controlled",
		acknowledgeSnapshot: true,
		authorizeLive: false,
	});
	const module = process.env.SOCRATES_PROMPTFOO_MODULE ?? "promptfoo";
	const { evaluate } = await import(module);
	const evaluation = await evaluate(
		{
			prompts: ["Create controlled result"],
			providers: [service.provider(experiment.id, experiment.trials[0]!.id)],
			tests: [
				{
					vars: {},
					assert: [
						{
							type: "javascript",
							value: 'JSON.parse(output).outcome === "verified_success"',
						},
					],
				},
			],
			sharing: false,
			writeLatestResults: false,
		},
		{ cache: false, maxConcurrency: 1, showProgressBar: false },
	);
	const summary = await evaluation.toEvaluateSummary();
	if (summary.stats.successes !== 1 || summary.stats.failures !== 0)
		throw new Error(`arena_evaluation_failed:${JSON.stringify(summary.stats)}`);
	const result = service.results(experiment.id);
	if (!result.trials[0]?.commandId || f.nativeCalls.length === 0)
		throw new Error("arena_no_real_task");
	console.log(
		JSON.stringify({
			library: "promptfoo",
			version: "0.125.1",
			successes: summary.stats.successes,
			failures: summary.stats.failures,
			nativeRequests: f.nativeCalls.length,
			outcome: result.trials[0].outcome,
			metrics: result.metrics,
			network: "forbidden",
		}),
	);
} finally {
	await service.shutdown();
	await f.close();
	globalThis.fetch = priorFetch;
	rmSync(configDir, { recursive: true, force: true });
}
