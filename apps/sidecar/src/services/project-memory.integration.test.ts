import { test, expect } from "bun:test";
import { setupCostFlowFixture, untilCostFlow } from "./cost-flow-fixture";
test("production command freeze and Native request include confirmed provider-authorized memory", async () => {
	const bodies: unknown[] = [];
	const f = await setupCostFlowFixture({
		onNativeRequest: (body) => bodies.push(body),
	});
	try {
		const room = f.sessions.get(f.roomIds.work)!;
		f.sessions.updateCollaboration(room.id, {
			...room.collaboration,
			strategy: "single",
		});
		f.projectMemory.save(
			f.roomIds.work,
			{ kind: "constraint", content: "PROTECTED_MEMORY_SENTINEL" },
			{ status: "confirmed" },
		);
		const command = await f.commands.submit({
			roomId: f.roomIds.work,
			clientRequestId: "memory-real-native",
			content: "Complete controlled task",
			intent: "execute",
			mentions: [],
		});
		await untilCostFlow(
			() => f.commands.get(command.commandId)?.status === "completed",
			"memory_native",
		);
		expect(bodies.length).toBeGreaterThan(0);
		expect(JSON.stringify(bodies)).toContain("PROTECTED_MEMORY_SENTINEL");
		expect(
			f.projectMemory.manifests(f.roomIds.work, command.commandId)[0].selected,
		).toHaveLength(1);
		expect(
			f.broker.ledger.list({ rootTaskId: command.commandId }).length,
		).toBeGreaterThan(0);
	} finally {
		await f.close();
	}
});
test("two distinct Provider members share confirmed background only after explicit Chat binding", async () => {
	const calls: any[] = [];
	const f = await setupCostFlowFixture({
		onGatewayRequest: (request) => calls.push(request),
	});
	try {
		f.db.exec(
			"INSERT INTO providers(id,name,type,base_url,default_model,api_key_ref,enabled,created_at,updated_at) SELECT 'fixture-provider-2','Second controlled provider',type,base_url,default_model,api_key_ref,enabled,created_at,updated_at FROM providers WHERE id='fixture-provider'",
		);
		const room = f.sessions.get(f.roomIds.chat)!;
		const b = room.agents.find((a) => a.agentId === "fixture-b")!;
		f.sessions.updateAgentSnapshot(room.id, "fixture-b", {
			...b.snapshot,
			providerId: "fixture-provider-2",
		});
		const e = f.projectMemory.save(
			f.roomIds.work,
			{
				kind: "constraint",
				content: "SHARED_PROJECT_CONSTRAINT",
				allowedProviders: ["fixture-provider", "fixture-provider-2"],
			},
			{ status: "confirmed" },
		);
		f.projectMemory.bind(room.id, f.roomIds.work, [e.id]);
		const command = await f.commands.submit({
			roomId: room.id,
			clientRequestId: "memory-two-providers",
			content: "Discuss the shared constraint",
			intent: "discuss",
			mentions: [],
		});
		await untilCostFlow(
			() => f.commands.get(command.commandId)?.status === "completed",
			"memory_chat",
		);
		for (const providerId of ["fixture-provider", "fixture-provider-2"])
			expect(
				calls.some(
					(c) =>
						c.invocation.providerConnectionId === providerId &&
						JSON.stringify(c.messages).includes("SHARED_PROJECT_CONSTRAINT"),
				),
			).toBe(true);
		expect(f.nativeCalls).toHaveLength(0);
		expect(f.projectMemory.manifests(room.id, command.commandId)).toHaveLength(
			2,
		);
	} finally {
		await f.close();
	}
});
test("persisted task query ranks bounded memory in actual Native payload without explicit caller query", async () => {
	const bodies: unknown[] = [];
	const f = await setupCostFlowFixture({
		onNativeRequest: (body) => bodies.push(body),
	});
	try {
		const room = f.sessions.get(f.roomIds.work)!;
		f.sessions.updateCollaboration(room.id, {
			...room.collaboration,
			strategy: "single",
		});
		f.projectMemory.save(
			room.id,
			{ kind: "todo", content: "VERIFY_TARGET " + "R".repeat(1100) },
			{ status: "confirmed" },
		);
		f.projectMemory.save(
			room.id,
			{ kind: "todo", content: "IRRELEVANT_CONTEXT " + "X".repeat(1100) },
			{ status: "confirmed" },
		);
		const command = await f.commands.submit({
			roomId: room.id,
			clientRequestId: "memory-relevance",
			content: "VERIFY_TARGET",
			intent: "execute",
			mentions: [],
		});
		await untilCostFlow(
			() => f.commands.get(command.commandId)?.status === "completed",
			"memory_rank",
		);
		const sent = JSON.stringify(bodies);
		expect(sent).toContain("RRRRRRRR");
		expect(sent).not.toContain("IRRELEVANT_CONTEXT");
		expect(
			f.projectMemory.manifests(room.id, command.commandId)[0].excluded.budget,
		).toBe(1);
	} finally {
		await f.close();
	}
});
