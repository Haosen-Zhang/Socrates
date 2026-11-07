// Run with SOCRATES_FIXTURE_WRITE_APPROVAL=1 bun run scripts/cost-aware-fixture.ts.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const metadata = JSON.parse(readFileSync('/private/tmp/socrates-cost-fixture.json', 'utf8'));
if (metadata.source !== 'synthetic-fixture' || !metadata.writeApprovalFlow) throw new Error('Requires controlled write-approval fixture');
const headers = { Authorization: `Bearer ${metadata.token}`, 'Content-Type': 'application/json' };
const request = async path => {
  const response = await fetch(`http://127.0.0.1:${metadata.port}${path}`, { headers });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
};
if (!(await request('/health')).controlledFixture) throw new Error('Refusing a real sidecar');
const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 1040 } });
page.setDefaultTimeout(15000);
const out = resolve('output/playwright/write-approval');
mkdirSync(out, { recursive: true });
const checks = [], pageErrors = [], externalRequests = [], decisions = [];
const check = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) throw new Error(name); };
const waitUntil = async (query, label) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await query(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timed out: ${label}`);
};
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('request', req => {
  const url = new URL(req.url());
  if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) externalRequests.push(req.url());
  if (req.method() === 'POST' && /\/multi\/approvals\/.+\/decision$/.test(url.pathname)) decisions.push(req.postDataJSON().decision);
});
await page.addInitScript(({ port, token }) => {
  localStorage.clear(); localStorage.setItem('socrates.lang', 'en');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = { invoke: async command => command === 'sidecar_handshake' ? { port, token } : null,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 0, unregisterCallback() {} };
}, metadata);

try {
  const room = (await request('/sessions')).find(item => item.id === metadata.roomIds.work);
  await page.goto('http://127.0.0.1:45338/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  const entry = page.getByRole('complementary').getByText(room.title, { exact: true });
  if (!await entry.isVisible()) await page.getByRole('complementary').getByRole('button', { expanded: false }).first().click();
  await entry.click();
  const composer = page.getByRole('textbox', { name: 'Task input', exact: true });
  await composer.fill('Write the controlled approved files, retaining exact plan approval and scope checks.');
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Approve exact plan', exact: true }).click();
  const task = await waitUntil(async () => (await request(`/multi/sessions/${room.id}/tasks`))[0], 'created team task');
  const view = () => request(`/multi/tasks/${task.id}`);
  const first = await waitUntil(async () => (await view()).pendingApprovals.find(item => item.kind === 'write_file'), 'write approval');
  const sessionAllow = page.getByRole('button', { name: 'Allow for session', exact: true });
  await sessionAllow.first().waitFor();
  check('The session-allow button is enabled for a scoped ordinary workspace write', await sessionAllow.first().isEnabled() && first.sessionId === room.id && first.toolGeneration === 1);
  check('No file is written before permission', !existsSync(join(metadata.workspace.canonicalPath, 'result.txt')));
  await page.screenshot({ path: `${out}/session-allow-enabled.png`, animations: 'disabled' });
  await sessionAllow.first().click();
  const expansion = await waitUntil(async () => (await view()).pendingApprovals.find(item => item.kind === 'plan_scope_expansion'), 'scope expansion after automatic second write');
  check('Session permission writes both approved files without another user click', readFileSync(join(metadata.workspace.canonicalPath, 'result.txt'), 'utf8').includes('file 0') && readFileSync(join(metadata.workspace.canonicalPath, 'second.txt'), 'utf8').includes('file 1') && decisions.join(',') === 'allow_session');
  check('The plan expansion remains pending and has no filesystem effect', expansion.freshHumanRequired && !existsSync(join(metadata.workspace.canonicalPath, 'outside-plan.txt')));
  await waitUntil(async () => await sessionAllow.count() === 0, 'broad permission hidden for fresh scope expansion');
  check('Fresh scope expansion exposes no session-allow button', await sessionAllow.count() === 0);
  await page.screenshot({ path: `${out}/plan-expansion-needs-confirmation.png`, animations: 'disabled' });
  await page.getByRole('button', { name: 'Allow once', exact: true }).first().click();
  await waitUntil(async () => (await view()).state === 'completed', 'completed controlled team task');
  check('Exact expansion approval completes the task and third write', existsSync(join(metadata.workspace.canonicalPath, 'outside-plan.txt')) && decisions.join(',') === 'allow_session,allow_once');
  check('No renderer errors', pageErrors.length === 0);
  check('No external browser requests', externalRequests.length === 0);
  await page.screenshot({ path: `${out}/writes-completed.png`, animations: 'disabled' });
  writeFileSync(`${out}/checks.json`, JSON.stringify({ generatedAt: new Date().toISOString(), checks, fixtureOnly: true, decisions, taskId: task.id }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, animations: 'disabled' }).catch(() => {});
  writeFileSync(`${out}/failure.txt`, `${error.stack ?? error}\n\n${await page.locator('body').innerText().catch(() => '')}`);
  throw error;
} finally { await browser.close(); }
