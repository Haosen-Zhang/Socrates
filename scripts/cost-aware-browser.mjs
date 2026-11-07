// Run only against scripts/cost-aware-fixture.ts and a local Vite instance.
// SOCRATES_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/cost-aware-browser.mjs
import { readFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const metadata = JSON.parse(readFileSync(process.env.SOCRATES_COST_FIXTURE_METADATA ?? '/private/tmp/socrates-cost-fixture.json', 'utf8'));
const ui = process.env.SOCRATES_COST_UI_URL ?? 'http://127.0.0.1:45338/';
if (new URL(ui).hostname !== '127.0.0.1') throw new Error('UI must be the isolated loopback fixture');
if (metadata.source !== 'synthetic-fixture' || !Number.isSafeInteger(metadata.port) || !metadata.roomIds?.work || !metadata.roomIds?.chat) throw new Error('Missing controlled fixture metadata');
const api = `http://127.0.0.1:${metadata.port}`;
const headers = { Authorization: `Bearer ${metadata.token}`, 'Content-Type': 'application/json' };
const request = async (path, body, method = 'POST') => {
  const response = await fetch(`${api}${path}`, { headers, ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 1040 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(20000);
const out = resolve(process.env.SOCRATES_COST_OUTPUT_DIR ?? 'output/playwright/cost-aware');
mkdirSync(out, { recursive: true });
const checks = [], pageErrors = [], externalRequests = [], quotes = [], submissions = [], reconciliations = [];
const check = (name, ok, evidence = undefined) => {
  checks.push({ name, ok, ...(evidence === undefined ? {} : { evidence }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) throw new Error(name);
};
const waitUntil = async (query, description, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await query(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timed out: ${description}`);
};
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('request', request => {
  const url = new URL(request.url());
  if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(request.url());
  if (request.method() === 'POST' && new URL(request.url()).pathname === '/room-commands') submissions.push(request.postDataJSON());
  if (request.method() === 'POST' && /\/cost\/invocations\/[^/]+\/reconcile$/.test(new URL(request.url()).pathname)) reconciliations.push(request.postDataJSON());
});
page.on('response', response => {
  if (new URL(response.url()).pathname === '/cost/quotes' && response.ok()) void response.json().then(value => quotes.push({ ...value, requestedBudget: response.request().postDataJSON().budget })).catch(() => {});
});
await page.addInitScript(({ port, token }) => {
  localStorage.clear(); localStorage.setItem('socrates.lang', 'en');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    invoke: async command => command === 'sidecar_handshake' ? { port, token } : null,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => 0, unregisterCallback() {},
  };
}, { port: metadata.port, token: metadata.token });

try {
  const health = await request('/health');
  if (!health.controlledFixture) throw new Error('Refusing a non-fixture server');
  const sessions = await request('/sessions');
  const work = sessions.find(session => session.id === metadata.roomIds.work);
  const chat = sessions.find(session => session.id === metadata.roomIds.chat);
  if (!work || !chat) throw new Error('Controlled rooms unavailable');
  await page.goto(ui, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  const workEntry = page.getByRole('complementary').getByText(work.title, { exact: true });
  if (!await workEntry.isVisible()) {
    const project = page.getByRole('complementary').getByRole('button', { expanded: false });
    if (await project.count()) await project.first().click();
  }
  await workEntry.click();
  const composer = page.getByRole('textbox', { name: 'Task input', exact: true });
  await composer.waitFor();
  await page.getByRole('combobox', { name: 'Response mode', exact: true }).selectOption('team');
  await page.getByRole('checkbox', { name: 'Task budget', exact: true }).check();
  await page.getByRole('textbox', { name: 'Task budget amount', exact: true }).fill(metadata.recommendedBudgetUsd ?? '0.015');
  check('Model output allowance is automatic in the composer', await page.getByRole('combobox', { name: 'Max output per request', exact: true }).count() === 0);
  const prompt = 'Implement the controlled cost-aware acceptance task and preserve completed tool facts.';
  await composer.fill(prompt);
  await waitUntil(() => quotes.find(quote => quote.roomId === work.id), 'a real task quote');
  await page.getByText('View breakdown', { exact: false }).click();
  await page.getByText('Manager and team execution', { exact: true }).waitFor();
  check('Real quote contains Manager, execution, review and retry stages', ['planning', 'execution', 'review', 'retry_allowance'].every(stage => quotes.at(-1).stages.some(item => item.stage === stage)));
  await page.screenshot({ path: `${out}/quote.png`, animations: 'disabled' });

  // Drop only the response: the actual room command service still commits it.
  // The automatic replacement quote must not create a second command on retry.
  let dropped = false, committed;
  await page.route('**/room-commands', async route => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true;
      const response = await route.fetch();
      committed = await response.json();
      await route.abort('failed');
    } else await route.continue();
  });
  const originalQuoteId = quotes.at(-1).id;
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await waitUntil(() => committed?.commandId, 'committed command whose response was dropped');
  await waitUntil(() => composer.inputValue().then(value => value === prompt), 'draft restored after dropped response');
  await waitUntil(() => quotes.some(quote => quote.id !== originalQuoteId), 'replacement quote after draft restoration');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await waitUntil(() => submissions.length >= 2, 'idempotent retry');
  check('A refreshed quote after a dropped response reuses the original command envelope', submissions[0].clientRequestId === submissions[1].clientRequestId && submissions[0].quoteId === submissions[1].quoteId);
  const commands = await request(`/room-commands/rooms/${work.id}`);
  check('The real room command service commits one task after a lost response', commands.filter(command => command.commandId === committed.commandId).length === 1 && commands.length === 1);

  const rootTaskId = committed.commandId;
  await page.getByRole('button', { name: 'Approve exact plan', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Approve exact plan', exact: true }).click();
  await waitUntil(async () => {
    const data = await request(`/cost/rooms/${work.id}`);
    return data.tasks.find(task => task.rootTaskId === rootTaskId && task.budget?.blockedReason);
  }, 'durable budget pause');
  await page.getByRole('button', { name: 'Increase budget', exact: true }).waitFor();
  check('Budget pause is visible with its bound task', await page.getByLabel('Cost and budget', { exact: true }).getByRole('status').filter({ hasText: 'The next request exceeds' }).isVisible());
  await page.screenshot({ path: `${out}/budget-paused.png`, animations: 'disabled' });
  await page.getByRole('textbox', { name: 'Add funds (USD)', exact: true }).fill(metadata.topUpAmount ?? '1.00');
  await page.getByRole('button', { name: 'Increase budget', exact: true }).dblclick();
  await waitUntil(async () => {
    const data = await request(`/cost/rooms/${work.id}`);
    return data.tasks.find(task => task.rootTaskId === rootTaskId)?.budget?.revision === 2;
  }, 'one versioned increase');
  const increased = await request(`/cost/rooms/${work.id}`);
  check('Double-click increase commits one budget revision', increased.tasks.find(task => task.rootTaskId === rootTaskId).budget.revision === 2);
  check('Budget resume requires no token-limit decision', await page.getByRole('combobox', { name: 'Output cap on resume', exact: true }).count() === 0);
  await page.getByRole('button', { name: 'Resume same task', exact: true }).click();
  await waitUntil(async () => {
    const data = await request(`/cost/rooms/${work.id}`);
    const task = data.tasks.find(task => task.rootTaskId === rootTaskId);
    if (task?.status === 'awaiting_tool_approval') {
      const allow = page.getByRole('button', { name: 'Allow once', exact: true });
      if (await allow.count()) await allow.first().click();
    }
    return task?.status === 'completed' ? data : false;
  }, 'the resumed team completes', 40000);
  const final = await request(`/cost/rooms/${work.id}`);
  const finalTask = final.tasks.find(task => task.rootTaskId === rootTaskId);
  check('Resume preserves the root task with automatic output management', final.tasks.length === 1 && finalTask.status === 'completed');
  check('Ledger contains real Manager, Worker and Reviewer invocations', ['plan', 'execute', 'review'].every(purpose => final.invocations.some(item => item.purpose === purpose && item.state === 'finished')));
  check('Known amounts reconcile and no reservation remains after completion', finalTask.budget.activeReservationsAtomic === '0' && finalTask.budget.unknownCount === 0 && final.summary.totals.some(total => BigInt(total.atomic) > 0n));
  const workCosts = page.getByLabel('Cost and budget', { exact: true });
  if (!await workCosts.evaluate(element => element.open)) await workCosts.locator(':scope > summary').click();
  await workCosts.getByText('Completed', { exact: true }).waitFor();
  for (const format of ['JSON', 'CSV']) {
    const [download] = await Promise.all([page.waitForEvent('download'), workCosts.getByRole('button', { name: `Export ${format}`, exact: true }).click()]);
    const path = `${out}/ledger.${format.toLowerCase()}`;
    await download.saveAs(path);
    const content = readFileSync(path, 'utf8');
    check(`${format} export contains ledger facts and no conversation text`, !content.includes(prompt) && (format === 'JSON' ? JSON.parse(content).summary.unknownCount === 0 : content.includes('price_snapshot_id')));
  }
  await page.screenshot({ path: `${out}/completed.png`, animations: 'disabled' });

  let releaseLateQuote, lateQuoteStarted = false;
  await page.route('**/cost/quotes', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().content === 'Late Work quote') {
      const response = await route.fetch();
      await new Promise(resolve => { releaseLateQuote = resolve; lateQuoteStarted = true; });
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await page.getByRole('textbox', { name: 'Task input', exact: true }).fill('Late Work quote');
  await waitUntil(() => lateQuoteStarted, 'a real quote response held for room-switch race');
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByRole('complementary').getByText(chat.title, { exact: true }).click();
  await page.getByRole('textbox', { name: 'Task input', exact: true }).fill('Separate Chat draft');
  releaseLateQuote();
  check('Room switching keeps the second room draft and cost projection separate', await page.getByRole('textbox', { name: 'Task input', exact: true }).inputValue() === 'Separate Chat draft' && (await request(`/cost/rooms/${chat.id}`)).summary.invocations === 0);
  const beforeIme = submissions.length;
  await page.getByRole('textbox', { name: 'Task input', exact: true }).evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  });
  check('IME confirmation does not submit a task', submissions.length === beforeIme);

  // A transport fault is below the real command/broker/ledger services.
  await request('/fixture/next-call-unknown', {});
  await page.getByRole('checkbox', { name: 'Task budget', exact: true }).check();
  await page.getByRole('textbox', { name: 'Task budget amount', exact: true }).fill('1.00');
  await waitUntil(() => quotes.some(quote => quote.roomId === chat.id && quote.requestedBudget?.limitAtomic === '1000000000000'), 'bound automatic Chat quote for unknown-outcome test');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const unresolved = await waitUntil(async () => {
    const data = await request(`/cost/rooms/${chat.id}`);
    return data.summary.unknownCount > 0 ? data : false;
  }, 'unknown provider usage remains exposed');
  const unknownCall = unresolved.invocations.find(item => item.state === 'outcome_unknown');
  check('A dropped provider result retains unknown exposure and original price evidence', !!unknownCall && unresolved.tasks[0].budget.unresolvedExposureAtomic !== '0' && unknownCall.usage === null);
  const chatCosts = page.getByLabel('Cost and budget', { exact: true });
  if (!await chatCosts.evaluate(element => element.open)) await chatCosts.locator(':scope > summary').click();
  await chatCosts.getByText('Invocation details', { exact: true }).click();
  await chatCosts.getByText('Manual bill reconciliation', { exact: true }).click();
  check('Manual reconciliation starts disabled before bill confirmation', await chatCosts.getByRole('button', { name: 'Save manual reconciliation', exact: true }).isDisabled());
  await chatCosts.getByRole('textbox', { name: 'Provider bill total for this request', exact: true }).fill('0.0002');
  await chatCosts.getByRole('textbox', { name: 'Bill reference or reconciliation reason', exact: true }).fill('Synthetic Provider bill #unknown-fixture');
  await chatCosts.getByRole('checkbox', { name: 'I checked this request\'s Provider bill and confirm the total and currency above.', exact: true }).check();
  await chatCosts.getByRole('button', { name: 'Save manual reconciliation', exact: true }).dblclick();
  const reconciled = await waitUntil(async () => {
    const data = await request(`/cost/rooms/${chat.id}`);
    return data.summary.unknownCount === 0 && data.invocations.some(item => item.reconciliation) ? data : false;
  }, 'manual invoice fact resolves cost uncertainty');
  const saved = reconciled.invocations.find(item => item.invocationId === unknownCall.invocationId);
  check('Manual reconciliation commits once and preserves unknown usage plus frozen price', reconciliations.length === 1 && saved.usage === null && saved.priceSnapshotId === unknownCall.priceSnapshotId && saved.reconciliation.amount.atomic === '200000000' && reconciled.tasks[0].budget.unresolvedExposureAtomic === '0');
  await chatCosts.getByText('Manually confirmed Provider bill amount', { exact: false }).waitFor();
  await page.screenshot({ path: `${out}/manual-reconciliation.png`, animations: 'disabled' });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Providers', exact: true }).click();
  const provider = settings.getByRole('article').filter({ hasText: metadata.providerName });
  await provider.getByText('Model prices and mapping', { exact: true }).click();
  await provider.getByLabel('Exact model ID', { exact: true }).fill(metadata.modelIds[0]);
  await provider.getByLabel('Input / 1M tokens', { exact: true }).fill('0.50');
  await provider.getByLabel('Output / 1M tokens', { exact: true }).fill('2.00');
  check('Custom price shows a labelled synthetic example', await provider.getByText('Synthetic example: 1,000 input + 1,000 output', { exact: false }).isVisible());
  await provider.getByRole('button', { name: 'Save price snapshot', exact: true }).click();
  await waitUntil(async () => (await request(`/cost/prices?providerId=${metadata.providerId}`)).some(price => price.modelId === metadata.modelIds[0] && price.rates.input === '0.50'), 'custom price persists');
  await provider.getByText('Import frozen catalog mapping', { exact: true }).click();
  await provider.getByRole('checkbox', { name: 'I checked that this connection\'s exact model uses these catalog billing rules.', exact: true }).check();
  await provider.getByRole('button', { name: 'Import confirmed catalog price', exact: true }).click();
  await waitUntil(async () => (await request(`/cost/prices?providerId=${metadata.providerId}`)).some(price => price.modelId === metadata.modelIds[0] && price.source === 'verified_catalog'), 'frozen catalog is imported through production service');
  const afterPrices = await request(`/cost/rooms/${work.id}`);
  check('Custom and catalog imports preserve historical invocation prices and totals', JSON.stringify(afterPrices.summary.totals) === JSON.stringify(final.summary.totals) && afterPrices.invocations.every(item => final.invocations.some(original => original.invocationId === item.invocationId && original.priceSnapshotId === item.priceSnapshotId)));
  await page.screenshot({ path: `${out}/provider-prices.png`, animations: 'disabled' });
  await settings.getByRole('button', { name: 'General', exact: true }).click();
  await settings.getByRole('button', { name: 'Light', exact: true }).click();
  await settings.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await waitUntil(() => page.locator('html').getAttribute('data-theme').then(value => value === 'light'), 'light theme applies');
  await page.setViewportSize({ width: 900, height: 760 });
  check('Cost controls remain inside the resized viewport', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.screenshot({ path: `${out}/chat-900.png`, animations: 'disabled' });
  check('No renderer errors', pageErrors.length === 0, pageErrors);
  check('No external browser requests', externalRequests.length === 0, externalRequests);
  for (const file of ['failure.txt', 'failure.png']) { try { unlinkSync(`${out}/${file}`); } catch { /* No failed replay. */ } }
  writeFileSync(`${out}/checks.json`, JSON.stringify({ generatedAt: new Date().toISOString(), checks, rootTaskId, knownTotals: final.summary.totals, calls: final.summary.invocations, fixtureOnly: true }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, animations: 'disabled' }).catch(() => {});
  writeFileSync(`${out}/failure.txt`, `${error.stack ?? error}\n\n${await page.locator('body').innerText().catch(() => '')}`);
  writeFileSync(`${out}/checks.json`, JSON.stringify({ generatedAt: new Date().toISOString(), checks, pageErrors, externalRequests, failure: String(error) }, null, 2));
  throw error;
} finally { await browser.close(); }
