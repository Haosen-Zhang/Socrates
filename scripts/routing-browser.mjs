// Prerequisites: routing-browser-fixture.ts and Vite on 127.0.0.1:45348.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const metadata = JSON.parse(readFileSync("/private/tmp/socrates-routing-browser-fixture.json", "utf8"));
assert.equal(metadata.source, "synthetic-routing-browser");
const api = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${metadata.port}${path}`, { headers: { Authorization: `Bearer ${metadata.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
};
assert.equal((await api("/health")).controlledFixture, true);
const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1420, height: 1000 } });
page.setDefaultTimeout(15000);
const out = "output/playwright/routing";
mkdirSync(out, { recursive: true });
const checks = [], errors = [], external = [], quotes = [], decisions = [], traffic = [];
const check = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); assert.ok(ok, name); };
const until = async (fn, label) => { for (let index = 0; index < 400; index++) { if (await fn()) return; await page.waitForTimeout(75); } throw Error(`Timed out: ${label}`); };
const room = async () => (await api("/sessions")).find(item => item.id === metadata.roomIds.work);
const composer = () => page.locator("textarea.pixel-composer-input:visible");
const preset = () => page.locator("[data-routing-controls]").getByRole("combobox", { name: "Execution preset", exact: true });
const policy = () => page.getByRole("dialog", { name: "Execution policy", exact: true });
const routePanel = root => page.locator(`[data-routing-target="${root}"]`);
const currentRoute = root => api(`/routing/tasks/${encodeURIComponent(root)}`);
const quoteFor = (content, wantedPreset) => quotes.findLast(item => item.input.content === content && item.value.route?.preset === wantedPreset)?.value;
const openPanel = async root => { const panel = routePanel(root); await panel.waitFor(); if (!await panel.evaluate(node => node.open)) await panel.locator(":scope > summary").click(); return panel; };
const choosePreset = async value => { await preset().selectOption(value); await until(async () => { const config = (await room()).collaboration; return value === "custom" ? config.assignment.routing.mode === "manual" : config.strategy === "adaptive" && config.assignment.routing.automaticPolicy === (value === "economy" ? "cost" : value); }, `preset ${value} persisted`); };
const selectWork = async () => { await page.getByRole("tab", { name: "Work", exact: true }).click(); const sidebar = page.locator("[data-navigation-sidebar]"); const item = sidebar.getByText("Routing Work", { exact: true }); if (!await item.isVisible()) await sidebar.getByRole("button", { expanded: false }).first().click(); await item.click(); await composer().waitFor(); };
page.on("pageerror", error => errors.push(String(error)));
page.on("request", request => { const url = new URL(request.url()); if (["http:", "https:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname)) external.push(request.url()); });
page.on("response", async response => { if (response.url().endsWith("/cost/quotes")) { const row = { input: response.request().postDataJSON(), value: await response.json(), status: response.status() }; traffic.push(row); if (response.ok()) quotes.push(row); } });
page.on("framenavigated", frame => { if (frame === page.mainFrame()) traffic.push({ navigation: frame.url() }); });

const plan = await api("/verification/plans", { roomId: metadata.roomIds.work, requestId: crypto.randomUUID(), checks: [{ id: "output-file", label: "Controlled output exists", kind: "file", path: "result.txt", minBytes: 1, contains: "Written once by controlled Native tool.", required: true, origin: "user" }], artifactPaths: ["result.txt"], protectedPaths: [], manualJudgment: [] });
await api(`/verification/plans/${plan.id}/approve`, { requestId: crypto.randomUUID() });
await page.addInitScript(({ port, token, roomId, planId }) => {
  localStorage.setItem("socrates.lang", "en"); localStorage.setItem(`socrates.verification-plan.v1:${roomId}`, planId);
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = { invoke: async command => command === "sidecar_handshake" ? { port, token } : null, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } }, transformCallback: () => 0, unregisterCallback() {} };
}, { ...metadata, roomId: metadata.roomIds.work, planId: plan.id });

async function submit(content, wantedPreset, { finish = true } = {}) {
  const before = new Set((await api(`/room-commands/rooms/${metadata.roomIds.work}`)).map(item => item.commandId));
  await composer().fill(content);
  assert.equal(await composer().inputValue(), content, "The submitted draft remains in the controlled input");
  await until(() => Boolean(quoteFor(content, wantedPreset)), "real route quote");
  const quote = quoteFor(content, wantedPreset);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  let root;
  await until(async () => { root = (await api(`/room-commands/rooms/${metadata.roomIds.work}`)).find(item => !before.has(item.commandId))?.commandId; return Boolean(root); }, "durable command created");
  if (finish) {
    await until(async () => {
      const { workflow } = await currentRoute(root);
      if (workflow.status === "awaiting_plan") {
        const approve = page.getByRole("button", { name: "Approve exact plan", exact: true });
        if (await approve.isVisible()) await approve.click();
        const panel = await openPanel(root);
        const resume = panel.getByRole("button", { name: "Resume task", exact: true });
        if (await resume.isVisible() && await resume.isEnabled()) await resume.click();
      }
      if (["blocked", "failed", "cancelled"].includes(workflow.status)) throw Error(`Unexpected task ${workflow.status}: ${workflow.reason}`);
      return workflow.status === "completed";
    }, "routed task completion");
  }
  const value = await currentRoute(root); decisions.push(value); return { root, quote, ...value };
}

try {
  await page.goto("http://127.0.0.1:45348/"); await selectWork();
  await page.locator("[data-verification-controls]").getByRole("button", { name: "Verification · Approved plan", exact: true }).waitFor();
  check("Opening a legacy room does not silently enable adaptive routing", await preset().inputValue() === "legacy" && (await room()).collaboration.strategy === "single");
  const initialPool = (await room()).collaboration.assignment.callableAgentIds;
  for (const mode of ["economy", "balanced", "quality", "custom"]) { await choosePreset(mode); check(`${mode} preserves the permitted member subset`, JSON.stringify((await room()).collaboration.assignment.callableAgentIds) === JSON.stringify(initialPool)); }
  await choosePreset("economy");
  const beforeSmall = await api("/__routing/counts");
  const small = await submit("Update only module-a/readme.md with a concise local documentation fix.", "economy");
  const afterSmall = await api("/__routing/counts");
  check("A three-member room routes a small task to one real executor without a manager call", small.decision.selected.workflow === "direct" && afterSmall.gateway.length === beforeSmall.gateway.length && afterSmall.native.length > beforeSmall.native.length);
  const complex = "Update module-a/readme.md and module-b/readme.md as independent documentation packages, then integrate the result.";
  const presetRoutes = {};
  for (const mode of ["economy", "balanced", "quality", "custom"]) {
    await choosePreset(mode);
    const result = await submit(complex, mode);
    presetRoutes[mode] = result.decision.selected.workflow;
    check(`${mode} dispatches the quoted frozen workflow and records actual attempts`, result.decision.selectedCandidateId === result.quote.route.selectedCandidateId && result.workflow.attempts.length > 0 && result.workflow.attempts[0].candidateId === result.decision.selectedCandidateId);
  }
  check("The same offline task has explainably different preset workflows", new Set(Object.values(presetRoutes)).size > 1);
  await openPanel(decisions.at(-1).workflow.rootTaskId);
  await page.screenshot({ path: `${out}/completed-route.png`, animations: "disabled" });

  await choosePreset("economy");
  const chosenContent = `${complex} Keep this explicit workflow choice for this request.`;
  await composer().fill(chosenContent);
  await until(() => Boolean(quoteFor(chosenContent, "economy")), "candidate-selection quote");
  const recommended = quoteFor(chosenContent, "economy").route;
  const alternate = recommended.candidates.find(candidate => candidate.feasible && !candidate.fallbackOnly && candidate.workflow === "direct" && candidate.id !== recommended.selectedCandidateId);
  assert.ok(alternate, "The real quote has a permitted direct alternative");
  await page.locator("[data-route-preview]").click();
  const preview = page.getByRole("dialog", { name: "Recommended workflow", exact: true });
  await preview.getByText("This recommendation uses deterministic rules and cost estimates. Comparable outcome evidence is not yet available.", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/route-preview.png`, animations: "disabled" });
  await preview.locator(`[data-route-candidate="${alternate.id}"]`).getByRole("button", { name: "Use this workflow", exact: true }).click();
  await until(() => quoteFor(chosenContent, "economy")?.route.selectedCandidateId === alternate.id, "selected alternative repriced");
  const chosen = await submit(chosenContent, "economy");
  check("Choosing a real alternative reprices and dispatches that exact frozen workflow", chosen.decision.selectedCandidateId === alternate.id && chosen.decision.reasonCodes.includes("candidate_selected_by_user") && chosen.workflow.attempts[0].candidateId === alternate.id);
  await choosePreset("custom");

  await page.locator("[data-routing-controls]").getByRole("button", { name: "Routing options", exact: true }).click();
  await policy().getByRole("combobox", { name: "Fixed executor for local tasks", exact: true }).selectOption("fixture-a");
  await policy().getByRole("spinbutton", { name: "Maximum repairs", exact: true }).fill("0");
  const fallback = policy().locator("section").filter({ has: page.getByText("Allowed fallback members", { exact: true }) });
  await fallback.getByRole("checkbox", { name: "Fixture Reviewer", exact: true }).check();
  await policy().getByRole("button", { name: "Save policy", exact: true }).click();
  await until(() => policy().count().then(count => count === 0), "policy saved");
  await composer().fill("Update only module-a/readme.md @");
  await page.getByRole("option", { name: /@Fixture Reviewer/ }).click();
  const targetedContent = await composer().inputValue();
  await until(() => Boolean(quoteFor(targetedContent.trim(), "custom")?.route.lockedAgentIds.includes("fixture-b")), "hard target quote");
  const lockedQuote = quoteFor(targetedContent.trim(), "custom");
  check("An explicit mention overrides the custom default without broadening the member pool", JSON.stringify(lockedQuote.route.selected.assignments.executorIds) === '["fixture-b"]' && !lockedQuote.route.allowedAgentIds.includes("fixture-c"));
  const beforeTargeted = new Set((await api(`/room-commands/rooms/${metadata.roomIds.work}`)).map(item => item.commandId));
  await page.getByRole("button", { name: "Send", exact: true }).click();
  let targetedRoot;
  await until(async () => { targetedRoot = (await api(`/room-commands/rooms/${metadata.roomIds.work}`)).find(item => !beforeTargeted.has(item.commandId))?.commandId; return targetedRoot && (await currentRoute(targetedRoot)).workflow.status === "completed"; }, "targeted task completion");
  check("The explicitly targeted member is the recorded execution identity", (await currentRoute(targetedRoot)).workflow.attempts[0].assignments.executorIds.join() === "fixture-b");

  const failurePlan = await api("/verification/plans", { roomId: metadata.roomIds.work, requestId: crypto.randomUUID(), checks: [{ id: "actual-failure", label: "Required marker missing", kind: "file", path: "result.txt", contains: "MARKER_INTENTIONALLY_ABSENT", minBytes: 1, required: true, origin: "user" }], artifactPaths: ["result.txt"], protectedPaths: [], manualJudgment: [] });
  await api(`/verification/plans/${failurePlan.id}/approve`, { requestId: crypto.randomUUID() });
  await page.evaluate(({ roomId, planId }) => localStorage.setItem(`socrates.verification-plan.v1:${roomId}`, planId), { roomId: metadata.roomIds.work, planId: failurePlan.id });
  // Change the initialization script's pointer for this reload without modifying approval facts.
  await page.addInitScript(({ roomId, planId }) => localStorage.setItem(`socrates.verification-plan.v1:${roomId}`, planId), { roomId: metadata.roomIds.work, planId: failurePlan.id });
  await page.reload(); await selectWork();
  const failed = await submit("Update only module-a/readme.md and satisfy the selected required marker.", "custom", { finish: false });
  await until(async () => (await currentRoute(failed.root)).workflow.status === "awaiting_approval", "fallback proposal after real assertion failure");
  let panel = await openPanel(failed.root);
  await panel.getByRole("button", { name: "Approve this change", exact: true }).waitFor();
  const awaiting = await currentRoute(failed.root);
  check("A real failed assertion produces an explicit fallback proposal with evidence and additional cost", awaiting.workflow.pendingApproval.handoff.failureCategory === "verification" && awaiting.workflow.pendingApproval.handoff.evidenceRefs.length > 0 && awaiting.workflow.pendingApproval.estimatedAdditionalCost.highAtomic !== null);
  const countsBeforeReload = await api("/__routing/counts");
  await page.reload(); await selectWork(); panel = await openPanel(failed.root);
  await panel.getByRole("button", { name: "Approve this change", exact: true }).waitFor();
  check("Reload restores the durable approval without executing another model call", (await currentRoute(failed.root)).workflow.pendingApproval.id === awaiting.workflow.pendingApproval.id && JSON.stringify(await api("/__routing/counts")) === JSON.stringify(countsBeforeReload));
  await until(() => page.locator(".pixel-window-toolbar").textContent().then(text => text.includes("Awaiting approval")), "parent waiting status projected");
  check("Waiting for approval shows its actual disabled-input placeholder without a failure or working spinner", await page.getByRole("alert").count() === 0 && await page.getByText("Working…", { exact: true }).count() === 0 && await composer().isDisabled() && await composer().getAttribute("placeholder") === "Awaiting approval");
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/fallback-approval.png`, animations: "disabled" });
  await panel.getByRole("button", { name: "Approve this change", exact: true }).click();
  await until(async () => ["blocked", "failed", "completed"].includes((await currentRoute(failed.root)).workflow.status), "bounded fallback completed");
  const escalated = await currentRoute(failed.root); decisions.push(escalated);
  check("Approval starts a distinct allowed-member attempt and repeated failure stops the loop", escalated.workflow.attempts.some(attempt => attempt.kind === "escalation" && attempt.assignments.executorIds.includes("fixture-b")) && escalated.workflow.attempts.length === 2 && escalated.workflow.status === "failed" && escalated.workflow.reason === "routing_repeated_failure_without_change");
  const denied = await submit("Update only module-a/readme.md; this fixture will decline the fallback.", "custom", { finish: false });
  await until(async () => (await currentRoute(denied.root)).workflow.status === "awaiting_approval", "second fallback proposal");
  panel = await openPanel(denied.root);
  const beforeDeny = await api("/__routing/counts");
  await panel.getByRole("button", { name: "Deny change", exact: true }).click();
  await until(async () => (await currentRoute(denied.root)).workflow.status === "blocked", "fallback denied");
  check("Denying a member change records the decision without another model call", (await currentRoute(denied.root)).workflow.reason === "routing_escalation_denied" && JSON.stringify(await api("/__routing/counts")) === JSON.stringify(beforeDeny));
  const cancelled = await submit("Update only module-a/readme.md; this fixture will cancel the proposed fallback.", "custom", { finish: false });
  await until(async () => (await currentRoute(cancelled.root)).workflow.status === "awaiting_approval", "cancellable proposal");
  panel = await openPanel(cancelled.root);
  await panel.getByRole("button", { name: "Cancel task", exact: true }).click();
  await until(async () => (await currentRoute(cancelled.root)).workflow.status === "cancelled", "route cancelled");
  check("Cancelling a paused route clears its pending approval", (await currentRoute(cancelled.root)).workflow.pendingApproval === null);

  await page.locator("[data-routing-controls]").getByRole("button", { name: "Routing options", exact: true }).click();
  await policy().getByRole("checkbox", { name: "Limit to selected providers", exact: true }).check();
  await policy().getByRole("checkbox", { name: "Controlled fixture Provider", exact: true }).uncheck();
  await policy().getByRole("button", { name: "Save policy", exact: true }).click();
  await until(() => policy().count().then(count => count === 0), "provider permission saved");
  const beforeRestriction = await api("/__routing/counts");
  await composer().fill("Update only module-a/readme.md with no permitted provider.");
  await until(() => quotes.findLast(item => item.input.content === "Update only module-a/readme.md with no permitted provider.")?.value.route?.selected === null, "blocked route quote");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("alert").first().waitFor();
  check("An explicit empty provider permission blocks execution without an implicit fallback", (await room()).collaboration.assignment.routing.allowedProviderIds.length === 0 && JSON.stringify(await api("/__routing/counts")) === JSON.stringify(beforeRestriction));
  await composer().fill("");
  await page.setViewportSize({ width: 650, height: 600 });
  await page.locator("[data-routing-controls]").getByRole("button", { name: "Routing options", exact: true }).click();
  check("Advanced routing stays within a narrow scrollable drawer", (await policy().boundingBox()).height <= 600);
  await policy().getByRole("button", { name: /^(Close|Dismiss)$/ }).click();
  check("Closing advanced routing leaves the composer within the viewport", await composer().evaluate(node => { const rect = node.getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight + 1; }));
  await page.getByRole("tab", { name: "Chat", exact: true }).click();
  check("Chat does not expose execution routing controls", await page.locator("[data-routing-controls]").count() === 0);
  check("The browser used only local synthetic services without renderer exceptions", errors.length === 0 && external.length === 0);
} finally {
  writeFileSync(`${out}/checks.json`, JSON.stringify({ checks, errors, external }, null, 2));
  writeFileSync(`${out}/decisions.json`, JSON.stringify(decisions, null, 2));
  writeFileSync(`${out}/traffic.json`, JSON.stringify(traffic, null, 2));
  writeFileSync(`${out}/dom-debug.html`, await page.content());
  await page.screenshot({ path: `${out}/final.png`, animations: "disabled" }).catch(() => {});
  await browser.close();
}
