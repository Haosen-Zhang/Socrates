// Disposable fixture only: SOCRATES_FIXTURE_REASONING_PLANNER=1 bun run scripts/cost-aware-fixture.ts
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const metadata = JSON.parse(readFileSync('/private/tmp/socrates-cost-fixture.json', 'utf8'));
if (metadata.source !== 'synthetic-fixture' || !metadata.reasoningPlanner) throw new Error('Requires the controlled reasoning fixture');
const api = `http://127.0.0.1:${metadata.port}`;
const headers = { Authorization: `Bearer ${metadata.token}`, 'Content-Type': 'application/json' };
const request = async (path, body, method = 'POST') => {
  const response = await fetch(`${api}${path}`, { headers, ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
};
if (!(await request('/health')).controlledFixture) throw new Error('Refusing a real sidecar');
const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 1040 } });
page.setDefaultTimeout(15000);
const out = resolve('output/playwright/collaboration-regression');
mkdirSync(out, { recursive: true });
const checks = [], pageErrors = [], externalRequests = [], submissions = [];
const check = (name, ok, evidence) => {
  checks.push({ name, ok, ...(evidence === undefined ? {} : { evidence }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) throw new Error(name);
};
const waitUntil = async (query, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await query(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timed out: ${label}`);
};
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('request', req => {
  const url = new URL(req.url());
  if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(req.url());
  if (req.method() === 'POST' && url.pathname === '/room-commands') submissions.push(req.postDataJSON());
});
await page.addInitScript(({ port, token }) => {
  localStorage.clear(); localStorage.setItem('socrates.lang', 'en');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    invoke: async command => command === 'sidecar_handshake' ? { port, token } : null,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => 0, unregisterCallback() {},
  };
}, metadata);

try {
  const sessions = await request('/sessions');
  const chat = sessions.find(room => room.id === metadata.roomIds.chat);
  const work = sessions.find(room => room.id === metadata.roomIds.work);
  // Reproduce the old Chat shape through the real room/member APIs.
  await request(`/sessions/${chat.id}/agents/fixture-b`, {}, 'DELETE');
  await request(`/sessions/${chat.id}/collaboration`, { collaboration: { ...chat.collaboration,
    discussion: { ...chat.collaboration.discussion, enabled: false, speakerOrder: [], summaryAgentId: null } } }, 'PUT');
  await request(`/sessions/${chat.id}/agents`, { agentId: 'fixture-b', snapshot: chat.agents.find(member => member.agentId === 'fixture-b').snapshot });
  await page.goto('http://127.0.0.1:45338/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Chat', exact: true }).click();
  await page.getByRole('complementary').getByText(chat.title, { exact: true }).click();
  await page.getByRole('button', { name: 'Collaboration', exact: true }).click();
  const dialog = page.getByRole('dialog').filter({ hasText: 'COLLABORATION SETTINGS' });
  await dialog.getByRole('checkbox', { name: 'Team discussion', exact: true }).check();
  await dialog.getByRole('spinbutton', { name: 'Maximum discussion rounds', exact: true }).fill('3');
  await dialog.getByRole('combobox', { name: 'Discussion summary Agent', exact: true }).selectOption('fixture-b');
  check('Old Chat shows a complete speaking order after adding a member', await dialog.getByText('1. Fixture Builder', { exact: true }).isVisible() && await dialog.getByText('2. Fixture Reviewer', { exact: true }).isVisible());
  check('Chat settings Save is enabled after discussion edits', await dialog.getByRole('button', { name: 'Save', exact: true }).isEnabled());
  await page.screenshot({ path: `${out}/chat-save-enabled.png`, animations: 'disabled' });
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const saved = (await request('/sessions')).find(room => room.id === chat.id);
  check('Chat settings persist through the actual backend', saved.collaboration.discussion.enabled && saved.collaboration.discussion.maxRounds === 3 && saved.collaboration.discussion.summaryAgentId === 'fixture-b' && saved.collaboration.discussion.speakerOrder.join(',') === 'fixture-a,fixture-b');
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  const entry = page.getByRole('complementary').getByText(work.title, { exact: true });
  if (!await entry.isVisible()) await page.getByRole('complementary').getByRole('button', { expanded: false }).first().click();
  await entry.click();
  const composer = page.getByRole('textbox', { name: 'Task input', exact: true });
  await composer.waitFor();
  check('The composer exposes no token-limit controls', await page.getByRole('combobox', { name: /Max output|Token/i }).count() === 0);
  await page.getByRole('checkbox', { name: 'Task budget', exact: true }).check();
  await page.getByRole('textbox', { name: 'Task budget amount', exact: true }).fill('0.02');
  await composer.fill('Controlled automatic planning and budget-resume acceptance.');
  await page.getByText('Estimated cost:', { exact: false }).waitFor();
  await composer.press('Enter');
  const paused = await waitUntil(async () => {
    const data = await request(`/cost/rooms/${work.id}`);
    return data.tasks.find(task => task.status === 'paused') ? data : false;
  }, 'automatic expansion pauses at the monetary budget');
  const root = paused.tasks[0].rootTaskId;
  check('User submission contains only money controls and no token cap', submissions.length === 1 && submissions[0].maxOutputTokens === undefined && submissions[0].budget.limitAtomic === '20000000000');
  check('Truncated reasoning is charged once before the expanded request is blocked', paused.invocations.filter(call => call.state === 'finished').length === 1 && paused.invocations.find(call => call.state === 'finished').finishReason === 'length' && paused.tasks[0].budget.settledKnownAtomic === '9212000000');
  const costs = page.getByLabel('Cost and budget', { exact: true });
  if (!await costs.evaluate(element => element.open)) await costs.locator(':scope > summary').click();
  await costs.getByRole('button', { name: 'Increase budget', exact: true }).waitFor();
  check('Budget resume exposes no token-limit selector', await costs.getByRole('combobox', { name: /output|Token/i }).count() === 0);
  await page.screenshot({ path: `${out}/automatic-budget-paused.png`, animations: 'disabled' });
  await costs.getByRole('button', { name: 'Increase budget', exact: true }).click();
  await waitUntil(async () => (await request(`/cost/rooms/${work.id}`)).tasks[0].budget.revision === 2, 'funds committed');
  await costs.getByRole('button', { name: 'Resume same task', exact: true }).click();
  const planned = await waitUntil(async () => {
    const data = await request(`/cost/rooms/${work.id}`);
    return data.tasks[0].status === 'awaiting_plan_approval' ? data : false;
  }, 'automatic larger allowance yields an approvable plan');
  check('Resume keeps the root and completes planning without replaying the first call', planned.tasks[0].rootTaskId === root && planned.invocations.filter(call => call.state === 'finished').length === 2 && planned.invocations.some(call => call.finishReason === 'stop'));
  await page.getByRole('button', { name: 'Approve exact plan', exact: true }).waitFor();
  await page.screenshot({ path: `${out}/automatic-plan-ready.png`, animations: 'disabled' });
  check('No renderer errors', pageErrors.length === 0, pageErrors);
  check('No external browser requests', externalRequests.length === 0, externalRequests);
  writeFileSync(`${out}/checks.json`, JSON.stringify({ generatedAt: new Date().toISOString(), checks, fixtureOnly: true, rootTaskId: root }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, animations: 'disabled' }).catch(() => {});
  writeFileSync(`${out}/failure.txt`, `${error.stack ?? error}\n\n${await page.locator('body').innerText().catch(() => '')}`);
  throw error;
} finally { await browser.close(); }
