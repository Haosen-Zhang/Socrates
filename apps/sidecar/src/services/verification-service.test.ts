import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { VerificationCheck, VerificationPlan, VerificationView } from "@socrates/core";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { SessionStore } from "../store/session-store";
import { EventStore } from "../store/event-store";
import { ExecutionEventStore } from "../store/execution-event-store";
import { WorkspaceManager } from "../workspace/manager";
import { WorkspaceLeaseManager } from "../workspace/leases";
import { ToolOutputStore } from "../tools/output-store";
import { SupervisedCommandRunner, type WorkspaceCommandRunner } from "../tools/workspace-command-runner";
import { VerificationService } from "./verification-service";
import { verificationRoutes } from "../routes/verification";

describe("VerificationService durable local acceptance", () => {
  let base: string, root: string, db: Database, roomId: string, service: VerificationService;
  let workspaces: WorkspaceManager, sessions: SessionStore, leases: WorkspaceLeaseManager, approvals: ApprovalManager;
  let events: EventStore, executionEvents: ExecutionEventStore, outputs: ToolOutputStore, runner: WorkspaceCommandRunner, spawnCount: number;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "socrates-verification-")); root = join(base, "workspace"); mkdirSync(root);
    db = openDb(join(base, "facts.sqlite")); workspaces = new WorkspaceManager(db, join(base, "managed"));
    const workspace = workspaces.select(root);
    sessions = new SessionStore(db); leases = new WorkspaceLeaseManager(db, "verification-test"); approvals = new ApprovalManager(db);
    events = new EventStore(db); executionEvents = new ExecutionEventStore(db); outputs = new ToolOutputStore(db);
    roomId = sessions.create({ title: "preserve conversation", mode: "single_agent", workspaceId: workspace.id, primaryAgentId: "agent",
      agents: [{ agentId: "agent", snapshot: { providerId: "unused", modelId: "no-model", nickname: "Local checker" }, executionEligible: true }] }).id;
    spawnCount = 0;
    // Real process supervision and persisted output capture, only the OS adapter
    // is controlled so these tests need neither provider keys nor a Mac sandbox.
    runner = new SupervisedCommandRunner((_root, input) => { spawnCount++; return { executable: process.execPath, argv: input.argv, env: { PATH: "/usr/bin:/bin", NO_COLOR: "1" } }; }, 8192,
      context => outputs.createCommandCapture({ sessionId: roomId, workspaceIdentity: workspace.identityHash }, context.toolOperationId));
    service = createService();
    writeFileSync(join(root, "answer.json"), '{"answer":42}');
  });
  afterEach(async () => { await service.shutdown(); db.close(); rmSync(base, { recursive: true, force: true }); });
  function createService(commandRunner = runner) { return new VerificationService(db, sessions, workspaces, leases, approvals, events, executionEvents, outputs, { commandRunner }); }
  function prepare(checks: VerificationCheck[], extra: Partial<Parameters<VerificationService["prepare"]>[0]> = {}): VerificationPlan {
    return service.prepare({ roomId, requestId: crypto.randomUUID(), checks, artifactPaths: ["."], protectedPaths: [], ...extra });
  }
  function approved(checks: VerificationCheck[], extra: Partial<Parameters<VerificationService["prepare"]>[0]> = {}) {
    const plan = prepare(checks, extra); return service.approve(plan.id, crypto.randomUUID());
  }
  const file: VerificationCheck = { id: "artifact", label: "Expected artifact", required: true, kind: "json_schema", path: "answer.json",
    schema: { type: "object", required: ["answer"], properties: { answer: { type: "integer", const: 42 } }, additionalProperties: false }, origin: "user" };
  function command(parser: "bun_test" | "tap" | "exit_code" | "unsupported" = "bun_test", category: "test" | "build" = "test"): VerificationCheck {
    return { id: "tests", label: "Repository checks", required: true, origin: "user", kind: "command", category,
      command: { executable: "bun", argv: ["check.js"], timeoutMs: 2_000 }, parser, definitionPaths: ["check.js"] };
  }
  async function finishPending(view: VerificationView, decision: "allow_once" | "deny" = "allow_once") {
    expect(view.run?.pendingApprovals).toHaveLength(1);
    expect(spawnCount).toBe(0);
    return service.decide(view.run!.pendingApprovals[0]!.id, { requestId: crypto.randomUUID(), decision });
  }

  it("legacy without a plan stays unverified and does not inspect unavailable files", async () => {
    rmSync(root, { recursive: true });
    const view = await service.verify({ roomId, rootTaskId: "legacy-with-no-record" });
    expect(view).toMatchObject({ verificationStatus: "not_requested", gatePassed: true, outcome: "completed_unverified" });
    expect(spawnCount).toBe(0);
  });
  it("persists structured assertions and invalidates a formerly passed snapshot on read", async () => {
    const plan = approved([file]);
    const view = await service.verify(plan.target, { requestId: "assert" });
    expect(view).toMatchObject({ verificationStatus: "passed", outcome: "verified_success", gatePassed: true });
    expect(view.run!.evidence[0]!.assertions).toEqual([{ name: "json_schema", passed: true }]);
    writeFileSync(join(root, "answer.json"), '{"answer":0}');
    expect(service.view(plan.target)).toMatchObject({ verificationStatus: "invalidated", gatePassed: false });
    expect(service.getPlan(plan.id)?.baselineSnapshot.hash).toBe(plan.baselineSnapshot.hash);
  });
  it("always binds assertion files even when the requested artifact scope omits them", async () => {
    writeFileSync(join(root,"anchor.txt"),"stable anchor");
    const plan=approved([file],{artifactPaths:["anchor.txt"]});
    expect((await service.verify(plan.target)).verificationStatus).toBe("passed");
    writeFileSync(join(root,"answer.json"),'{"answer":0}');
    expect(service.view(plan.target)).toMatchObject({verificationStatus:"invalidated",gatePassed:false});
    expect(plan.artifactPaths).toContain("answer.json");
  });
  it("cannot substitute a stale report file for evidence produced by this operation", async () => {
    writeFileSync(join(root,"check.js"),'console.log("No tests were executed");');
    writeFileSync(join(root,"old-report.txt"),"1 pass\n0 fail\nRan 1 test across 1 file.\n");
    const check=command();if(check.kind==="command")check.reportPath="old-report.txt";
    const view=await finishPending(await service.verify(approved([check]).target));
    expect(view).toMatchObject({verificationStatus:"inconclusive",gatePassed:false});
    expect(view.run?.evidence[0]?.reason).toBe("verification_report_provenance_unavailable");
  });
  it("actually executes Bun tests only after exact approval and exposes persisted output", async () => {
    writeFileSync(join(root, "actual.test.ts"), 'import {test,expect} from "bun:test"; test("answer",()=>expect(JSON.parse(require("fs").readFileSync("answer.json","utf8")).answer).toBe(42));');
    const check = { ...command(), origin: "repository" as const, command: { executable: "bun", argv: ["test", "actual.test.ts"], timeoutMs: 5_000 }, definitionPaths: ["actual.test.ts"] };
    const plan = approved([check]);
    const pending = await service.verify(plan.target, { requestId: "real-bun" });
    expect(pending.verificationStatus).toBe("pending");
    const approvalId = pending.run!.pendingApprovals[0]!.id;
    expect(spawnCount).toBe(0);
    const view = await service.decide(approvalId, { decision: "allow_once", requestId: "approve-real-bun" });
    expect(view.verificationStatus).toBe("passed");
    const evidence = view.run!.evidence[0]!;
    expect(evidence).toMatchObject({ exitCode: 0, counts: { tests: 1, passed: 1, failed: 0, skipped: 0 }, approvalId });
    expect(evidence.operationId).toBeTruthy(); expect(evidence.stdoutRef).toBeTruthy(); expect(evidence.stderrRef).toBeTruthy();
    expect(service.readEvidenceOutput(evidence.id, roomId, "stderr").text).toContain("1 pass");
    expect(() => service.readEvidenceOutput(evidence.id, "another-room", "stderr")).toThrow("verification_evidence_not_found");
    expect((await service.decide(approvalId, { decision: "allow_once", requestId: "approve-real-bun" })).verificationStatus).toBe("passed");
    expect((await service.verify(plan.target, { requestId: "real-bun" })).run?.id).toBe(view.run?.id);
    expect(spawnCount).toBe(1);
  });
  it("false success claims cannot override a real nonzero process exit", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("all tests passed; work is complete"); process.exitCode=1;');
    const view = await finishPending(await service.verify(approved([command()]).target));
    expect(view).toMatchObject({ verificationStatus: "failed", outcome: "verification_failed", gatePassed: false });
    expect(view.run!.evidence[0]).toMatchObject({ exitCode: 1, reason: "verification_nonzero_exit" });
  });
  for (const [label, text, reason] of [
    ["zero executed tests", "0 pass\n0 fail\nRan 0 tests across 0 files.", "verification_no_tests_executed"],
    ["malformed report", "tests passed", "verification_report_invalid"],
  ]) it(`does not certify ${label}`, async () => {
    writeFileSync(join(root, "check.js"), `console.error(${JSON.stringify(text)});`);
    const view = await finishPending(await service.verify(approved([command()]).target));
    expect(view.verificationStatus).toBe("inconclusive"); expect(view.run!.evidence[0]?.reason).toBe(reason);
  });
  it("denied approval creates non-passing evidence and never spawns", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("should not run")');
    const view = await finishPending(await service.verify(approved([command()]).target), "deny");
    expect(view.run!.evidence[0]?.reason).toBe("verification_permission_denied"); expect(view.gatePassed).toBe(false); expect(spawnCount).toBe(0);
  });
  it("timeout retains partial actual output and is inconclusive", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("checking"); setInterval(()=>{},1000);');
    const check = command(); if (check.kind === "command") check.command.timeoutMs = 100;
    const view = await finishPending(await service.verify(approved([check]).target));
    expect(view.verificationStatus).toBe("inconclusive");
    expect(view.run!.evidence[0]).toMatchObject({ reason: "verification_timeout", timedOut: true });
  });
  it("missing environment is distinct from a failed acceptance assertion", async () => {
    writeFileSync(join(root, "check.js"), "// unreachable");
    service = createService({ async run() { throw new Error("shell_sandbox_unavailable"); } });
    const view = await finishPending(await service.verify(approved([command()]).target));
    expect(view.run!.evidence[0]?.reason).toBe("verification_environment_unavailable"); expect(view.verificationStatus).toBe("inconclusive");
  });
  it("records baseline failures separately and binds their evidence to the final run", async () => {
    writeFileSync(join(root, "answer.json"), '{"answer":0}');
    const plan = prepare([file]);
    const baseline = await service.baseline(plan.id, "baseline");
    expect(baseline.run).toMatchObject({ mode: "baseline", status: "failed" }); expect(baseline.verificationStatus).toBe("pending");
    service.approve(plan.id, "approve"); writeFileSync(join(root, "answer.json"), '{"answer":42}');
    const view = await service.verify(plan.target);
    expect(view.verificationStatus).toBe("passed");
    expect(view.run!.evidence[0]).toMatchObject({ baselineStatus: "failed", changedPaths: ["answer.json"] });
  });
  it("frozen check definition changes block both old approval and final execution", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("before")');
    const plan = approved([command()]); writeFileSync(join(root, "check.js"), 'console.log("altered")');
    const view = await service.verify(plan.target);
    expect(view).toMatchObject({ verificationStatus: "invalidated", gatePassed: false, outcome: "blocked" });
    expect(view.run?.reason).toBe("validation_contract_changed"); expect(spawnCount).toBe(0);
    expect(() => service.approve(plan.id, "approve-again")).toThrow("validation_contract_changed");
    const next = prepare([command()], { rootTaskId: plan.target.rootTaskId });
    expect(next.version).toBe(2); expect(next.approvalStatus).toBe("proposed");
    expect(service.getPlan(plan.id)?.hash).toBe(plan.hash);
  });
  it("narrow artifact scopes cannot omit repository scripts and independent test definitions", async () => {
    writeFileSync(join(root,"package.json"),'{"scripts":{"test":"bun test"}}');
    writeFileSync(join(root,"frozen.test.ts"),'import{test,expect}from"bun:test";test("assertion",()=>expect(1).toBe(2));');
    const check=command();if(check.kind==="command"){check.definitionPaths=[];check.command.argv=["run","test"];}
    const plan=approved([check],{artifactPaths:["answer.json"]});
    writeFileSync(join(root,"frozen.test.ts"),'// weakened test');
    const view=await service.verify(plan.target);
    expect(view.run?.reason).toBe("validation_contract_changed");
    expect(view.gatePassed).toBe(false);expect(spawnCount).toBe(0);
  });
  it("restart recovery never retries an interrupted or awaiting-approval command", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("do not retry")');
    const plan = approved([command()]); const pending = await service.verify(plan.target, { requestId: "initial" });
    const restarted = createService(); expect(restarted.recoverInterrupted()).toBe(1);
    expect(restarted.view(plan.target)).toMatchObject({ verificationStatus: "inconclusive", gatePassed: false });
    expect(approvals.getRequest(pending.run!.pendingApprovals[0]!.id)?.status).toBe("expired");
    expect((await restarted.verify(plan.target, { requestId: "initial" })).run?.reason).toBe("verification_interrupted_requires_rerun");
    expect(spawnCount).toBe(0);
  });
  it("accepting incomplete evidence stays unverified and expires its approval", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("do not execute")');
    const plan = approved([command()]); const pending = await service.verify(plan.target);
    const view = service.acceptUnverified(plan.target, "accept");
    expect(view).toMatchObject({ acceptedUnverified: true, verificationStatus: "inconclusive", outcome: "completed_unverified", gatePassed: true });
    expect(approvals.getRequest(pending.run!.pendingApprovals[0]!.id)?.status).toBe("expired");
    expect(service.acceptUnverified(plan.target, "accept").acceptedUnverified).toBe(true);
    writeFileSync(join(root, "answer.json"), '{"answer":0}');
    expect(service.view(plan.target).acceptedUnverified).toBe(false); expect(spawnCount).toBe(0);
  });
  it("rejects duplicate request changes and serializes command verification", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("do not execute")');
    const plan = approved([command()], { requestId: "prepare" });
    expect(() => prepare([file], { requestId: "prepare" })).toThrow("verification_request_conflict");
    await service.verify(plan.target, { requestId: "run" });
    await expect(service.verify(plan.target, { requestId: "run", baseline: true })).rejects.toThrow("verification_request_conflict");
    await expect(service.verify(plan.target, { requestId: "another-run" })).rejects.toThrow("verification_approval_pending");
  });
  it("cancellation joins the real process, persists partial evidence and stays idempotent", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("started"); setInterval(()=>{},1000);');
    const plan = approved([command()]); const pending = await service.verify(plan.target);
    const executing = service.decide(pending.run!.pendingApprovals[0]!.id, { decision: "allow_once", requestId: "allow-running" });
    for (let tries=0; spawnCount===0 && tries<100; tries++) await Bun.sleep(5);
    expect(spawnCount).toBe(1);
    const cancelled = await service.cancel(plan.target, "cancel-running");
    await executing;
    expect(cancelled).toMatchObject({ verificationStatus: "inconclusive", outcome: "cancelled", gatePassed: false });
    expect(cancelled.run?.reason).toBe("verification_cancelled");
    expect(db.query("SELECT * FROM workspace_leases WHERE mode='write'").all()).toHaveLength(0);
    const rerun = await service.verify(plan.target, { requestId: "explicit-rerun" });
    await service.cancel(plan.target, "cancel-running");
    expect(service.view(plan.target).run?.id).toBe(rerun.run?.id);
    expect(service.view(plan.target).run?.status).toBe("pending");
  });
  it("checks cannot change the artifact and certify the prior snapshot", async () => {
    writeFileSync(join(root, "check.js"), 'require("fs").writeFileSync("answer.json", "changed");');
    const view = await finishPending(await service.verify(approved([command("exit_code", "build")]).target));
    expect(view).toMatchObject({ verificationStatus: "invalidated", gatePassed: false });
    expect(view.run?.reason).toBe("verification_artifact_changed");
    expect(view.run?.evidence[0]?.exitCode).toBe(0);
  });
  it("missing structured report and unknown JSON Schema keywords fail closed", async () => {
    writeFileSync(join(root, "check.js"), 'console.log("completed")');
    const check = command(); if (check.kind === "command") check.reportPath="missing-report.txt";
    const view = await finishPending(await service.verify(approved([check]).target));
    expect(view.run?.evidence[0]?.reason).toBe("verification_report_provenance_unavailable");
    expect(view.verificationStatus).toBe("inconclusive");
    const invalidSchema = approved([{ ...file, kind:"json_schema", path:"answer.json", schema:{type:"object", unknownAssertion:true} }]);
    const invalid = await service.verify(invalidSchema.target);
    expect(invalid.run?.evidence[0]?.reason).toBe("verification_schema_unsupported");
    expect(invalid.gatePassed).toBe(false);
  });
  it("does not invoke asynchronous JSON Schema or leak unhandled validation rejection", async () => {
    const asyncPlan=approved([{...file,kind:"json_schema",path:"answer.json",schema:{$async:true,type:"object",properties:{answer:{type:"integer",const:0}}}}]);
    const result=await service.verify(asyncPlan.target);
    expect(result.run?.evidence[0]?.reason).toBe("verification_schema_unsupported");
    expect(result.verificationStatus).toBe("inconclusive");expect(result.gatePassed).toBe(false);
    await Bun.sleep(10);
  });
  it("reopening the SQLite database preserves old conversation, plans and verified evidence", async () => {
    const plan = approved([file]); const verified = await service.verify(plan.target);
    await service.shutdown(); db.close(); db=openDb(join(base,"facts.sqlite"));
    workspaces=new WorkspaceManager(db,join(base,"managed")); sessions=new SessionStore(db); leases=new WorkspaceLeaseManager(db,"after-restart");
    approvals=new ApprovalManager(db); events=new EventStore(db); executionEvents=new ExecutionEventStore(db); outputs=new ToolOutputStore(db); service=createService();
    expect(service.recoverInterrupted()).toBe(0);
    expect(sessions.get(roomId)?.title).toBe("preserve conversation");
    expect(service.view(plan.target).run?.id).toBe(verified.run?.id);
    expect(service.view(plan.target).verificationStatus).toBe("passed");
    expect(db.query("SELECT * FROM verification_evidence").all()).toHaveLength(1);
  });
  it("binds an approved draft to a real command before dispatch without affecting package scope", async () => {
    const source=approved([file]);
    const rootTaskId=crypto.randomUUID();
    db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,created_at,updated_at) VALUES(?,?,?,?,?,'single_agent','pending','now','now')")
      .run(rootTaskId,roomId,"request","fingerprint","{}");
    const target={roomId,rootTaskId};const plan=service.bind(source.id,target);
    expect(plan).toMatchObject({sourcePlanId:source.id,target,approvalStatus:"approved",version:1});
    expect(service.bind(source.id,target).id).toBe(plan.id);
    expect((await service.verify(target)).verificationStatus).toBe("passed");
    expect(service.view({...target,workPackageId:"unconfigured-package"}).verificationStatus).toBe("not_requested");
    expect(()=>service.prepare({roomId,rootTaskId,workPackageId:"other-package",requestId:"invalid-package",checks:[file],artifactPaths:["."],protectedPaths:[]})).toThrow("verification_package_not_found");
    expect(()=>service.bind(source.id,{roomId,rootTaskId:"missing-command"})).toThrow("verification_target_not_found");
  });
  it("passing integration retains unverified outcome when a local failure was accepted", async () => {
    const rootTaskId=crypto.randomUUID(),taskId=crypto.randomUUID(),workPackageId=crypto.randomUUID();
    db.query("INSERT INTO multi_tasks(id,session_id,prompt,state,config_json,created_at,updated_at) VALUES(?,?,'task','paused','{}','now','now')").run(taskId,roomId);
    db.query("INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,task_id,created_at,updated_at) VALUES(?,?,?,'fingerprint','{}','team','pending',?,'now','now')").run(rootTaskId,roomId,rootTaskId,taskId);
    db.query("INSERT INTO work_packages(id,task_id,plan_version,definition_json,state,created_at,updated_at) VALUES(?,?,1,'{}','awaiting_verification','now','now')").run(workPackageId,taskId);
    const local=approved([{id:"local",label:"Missing local outcome",required:true,kind:"file",path:"missing.txt",minBytes:1}],{rootTaskId,workPackageId});
    const rootPlan=approved([file],{rootTaskId});
    expect((await service.verify(local.target)).verificationStatus).toBe("failed");
    expect((await service.verify(rootPlan.target))).toMatchObject({verificationStatus:"passed",outcome:"completed_unverified",gatePassed:false,unverifiedPackageIds:[workPackageId]});
    service.acceptUnverified(local.target,"accept-local");
    expect(service.view(rootPlan.target)).toMatchObject({verificationStatus:"passed",outcome:"completed_unverified",gatePassed:true,unverifiedPackageIds:[workPackageId]});
  });
  it("applies strict HTTP validation and uses the real plan/assertion service", async () => {
    const app = verificationRoutes(service);
    const bad = await app.request("/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, requestId: "bad", checks: [{ ...command(), command: { executable: "bun", argv: [], timeoutMs: -1 } }], artifactPaths: ["."], protectedPaths: [] }) });
    expect(bad.status).toBe(400);
    const response = await app.request("/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId, requestId: "http-plan", checks: [file], artifactPaths: ["."], protectedPaths: [] }) });
    expect(response.status).toBe(201); const plan = await response.json() as VerificationPlan;
    await app.request(`/plans/${plan.id}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "http-approve" }) });
    const run = await app.request("/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target: plan.target, requestId: "http-run" }) });
    expect(run.status).toBe(200); expect((await run.json() as VerificationView).verificationStatus).toBe("passed");
  });
});
