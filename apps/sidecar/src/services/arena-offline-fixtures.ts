import type { ArenaTask } from "../../../../packages/core/src/arena";
/** Small transport-only fixtures. Expected checks are registered before any model response. */
export const ARENA_OFFLINE_FIXTURES: Array<{
	id: string;
	files: Record<string, string>;
	task: ArenaTask;
	writes: Record<string, string>;
	budgetAtomic?: string;
}> = [
	{
		id: "simple-fix",
		files: { "context.txt": "Synthetic fixture" },
		task: {
			id: "simple-fix",
			category: "simple-fix",
			prompt: "OFFLINE_SIMPLE_FIX: fix the result.",
			checks: [
				{
					id: "value",
					label: "Independent expected value",
					kind: "file",
					path: "result.txt",
					contains: "corrected",
					origin: "user",
					required: true,
				},
			],
			artifactPaths: ["result.txt"],
			protectedPaths: [],
		},
		writes: { "result.txt": "corrected\n" },
	},
	{
		id: "cross-file",
		files: { "context.txt": "Synthetic fixture" },
		task: {
			id: "cross-file",
			category: "cross-file",
			prompt: "OFFLINE_CROSS_FILE: deliver both modules.",
			checks: [
				{
					id: "one",
					label: "First module",
					kind: "file",
					path: "one.ts",
					contains: "export const one = 1;",
					origin: "user",
					required: true,
				},
				{
					id: "two",
					label: "Second module imports first",
					kind: "file",
					path: "two.ts",
					contains: "import { one } from './one';",
					origin: "user",
					required: true,
				},
			],
			artifactPaths: ["one.ts", "two.ts"],
			protectedPaths: [],
		},
		writes: {
			"one.ts": "export const one = 1;\n",
			"two.ts": "import { one } from './one';\nexport const two = one + 1;\n",
		},
	},
	{
		id: "test-generation",
		files: {
			"context.txt": "Synthetic fixture",
			"subject.ts": "export const add=(a:number,b:number)=>a+b;\n",
			"acceptance.test.ts":
				"import {test,expect} from 'bun:test';\ntest('independent generated-test execution',()=>{const result=Bun.spawnSync([process.execPath,'test','generated.test.ts']);expect(result.exitCode).toBe(0);expect(result.stderr.toString()).toContain('1 pass');});\n",
		},
		task: {
			id: "test-generation",
			category: "test-generation",
			prompt:
				"OFFLINE_TEST_GENERATION: write a test for the provided add function.",
			checks: [
				{
					id: "assertion",
					label: "Independent required edge case",
					kind: "file",
					path: "generated.test.ts",
					contains: "expect(add(-2,2)).toBe(0)",
					origin: "user",
					required: true,
				},
				{
					id: "run",
					label: "Generated test actually executes",
					kind: "command",
					category: "test",
					command: { executable: "bun", argv: ["test", "acceptance.test.ts"] },
					parser: "bun_test",
					minTests: 1,
					origin: "repository",
					required: true,
				},
			],
			artifactPaths: ["generated.test.ts"],
			protectedPaths: ["subject.ts", "acceptance.test.ts"],
		},
		writes: {
			"generated.test.ts":
				"import {test,expect} from 'bun:test';\nimport {add} from './subject';\ntest('handles signed input',()=>{expect(add(-2,2)).toBe(0)});\n",
		},
	},
	{
		id: "dependency-failure",
		files: {
			"context.txt": "Synthetic fixture",
			"acceptance.test.ts":
				"import {test} from 'bun:test';\nimport 'missing-arena-fixture-package';\ntest('dependency',()=>{});\n",
		},
		task: {
			id: "dependency-failure",
			category: "dependency-failure",
			prompt:
				"OFFLINE_DEPENDENCY_FAILURE: generate the result; independent environment check may fail.",
			checks: [
				{
					id: "dependency",
					label: "Declared dependency must load",
					kind: "command",
					category: "test",
					command: { executable: "bun", argv: ["test", "acceptance.test.ts"] },
					parser: "bun_test",
					minTests: 1,
					origin: "repository",
					required: true,
				},
			],
			artifactPaths: ["result.txt"],
			protectedPaths: ["acceptance.test.ts"],
		},
		writes: { "result.txt": "Generated but dependency cannot load\n" },
	},
	{
		id: "budget-insufficient",
		files: { "context.txt": "Synthetic fixture" },
		task: {
			id: "budget-insufficient",
			category: "budget-insufficient",
			prompt: "OFFLINE_BUDGET: write a result only if admitted.",
			checks: [
				{
					id: "value",
					label: "Result must exist",
					kind: "file",
					path: "result.txt",
					origin: "user",
					required: true,
				},
			],
			artifactPaths: ["result.txt"],
			protectedPaths: [],
		},
		writes: { "result.txt": "must not be sent" },
		budgetAtomic: "1",
	},
];
export function arenaFixtureToolCalls(body: unknown) {
	const request = body as {
		messages?: Array<{ role: string; content?: unknown }>;
	};
	if (request.messages?.some((m) => m.role === "tool")) return [];
	const prompt = JSON.stringify(request.messages);
	const item = ARENA_OFFLINE_FIXTURES.find((f) =>
		prompt.includes(f.task.prompt),
	);
	if (!item) return undefined;
	return Object.entries(item.writes).map(([path, content], i) => ({
		id: `arena-${item.id}-${i}`,
		type: "function",
		function: {
			name: "write_file",
			arguments: JSON.stringify({ path, content, expectedSha256: null }),
		},
	}));
}
