// Run only with SOCRATES_FIXTURE_AUTOMATIC_PRICING=1 bun run scripts/cost-aware-fixture.ts.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const metadata = JSON.parse(readFileSync('/private/tmp/socrates-cost-fixture.json', 'utf8'));
if (metadata.source !== 'synthetic-fixture' || !metadata.automaticPricingView) throw new Error('Requires the controlled automatic-pricing fixture');
const headers = { Authorization: `Bearer ${metadata.token}`, 'Content-Type': 'application/json' };
const request = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${metadata.port}${path}`, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
};
if (!(await request('/health')).controlledFixture) throw new Error('Refusing a real sidecar');
const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 1040 } });
page.setDefaultTimeout(15000);
const out = resolve('output/playwright/automatic-pricing');
mkdirSync(out, { recursive: true });
const checks = [], errors = [], external = [];
const check = (name, ok) => { checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) throw new Error(name); };
const waitUntil = async (query, label) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await query(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timed out: ${label}`);
};
page.on('pageerror', error => errors.push(String(error)));
page.on('request', req => { const url = new URL(req.url()); if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) external.push(req.url()); });
await page.addInitScript(({ port, token }) => {
  localStorage.clear(); localStorage.setItem('socrates.lang', 'en');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = { invoke: async command => command === 'sidecar_handshake' ? { port, token } : null,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 0, unregisterCallback() {} };
}, metadata);
try {
  const initial = await request(`/cost/rooms/${metadata.roomIds.work}`);
  const frozen = initial.invocations.find(item => item.invocationId === 'pricing-example-2');
  check('Known-usage historical calls and new calls have automatic reference estimates', initial.summary.estimatedCount === 4 && initial.summary.outcomeUnknownCount === 0 && BigInt(initial.summary.estimatedTotals[0].atomic) > 0n);
  const room = (await request('/sessions')).find(item => item.id === metadata.roomIds.work);
  await page.goto('http://127.0.0.1:45338/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  const entry = page.getByRole('complementary').getByText(room.title, { exact: true });
  if (!await entry.isVisible()) await page.getByRole('complementary').getByRole('button', { expanded: false }).first().click();
  await entry.click();
  const costs = page.getByLabel('Cost and budget', { exact: true });
  await waitUntil(() => costs.locator(':scope > summary').innerText().then(text => text.includes('Reference estimate')), 'automatic estimate in collapsed heading');
  check('The main cost heading shows an amount without asking for reconciliation', !(await costs.locator(':scope > summary').innerText()).includes('awaiting reconciliation'));
  await costs.locator(':scope > summary').click();
  await costs.getByText('Invocation details', { exact: true }).click();
  check('No per-invocation bill forms are required for priced estimates', await costs.getByText('Manual bill reconciliation', { exact: true }).count() === 0);
  await page.screenshot({ path: `${out}/automatic-costs.png`, animations: 'disabled' });
  for (const format of ['JSON', 'CSV']) {
    const [download] = await Promise.all([page.waitForEvent('download'), costs.getByRole('button', { name: `Export ${format}`, exact: true }).click()]);
    const path = `${out}/reference-ledger.${format.toLowerCase()}`;
    await download.saveAs(path);
    const content = readFileSync(path, 'utf8');
    check(`${format} export keeps reference estimates separate from original facts`, format === 'JSON'
      ? JSON.parse(content).invocations.some(item => item.referenceEstimate && item.priceSnapshotId === null && item.amount === null)
      : content.includes('reference_estimate_atomic') && content.includes('728150000'));
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('button', { name: 'Providers', exact: true }).click();
  const provider = settings.getByRole('article').filter({ hasText: 'Official OpenAI reference' });
  await provider.getByText('Model prices and mapping', { exact: true }).click();
  const input = provider.getByLabel('Input / 1M tokens', { exact: true });
  const output = provider.getByLabel('Output / 1M tokens', { exact: true });
  await waitUntil(() => input.inputValue().then(value => value === '0.2'), 'official rates prefilled');
  check('Provider settings prefill official prices and explain that overrides are optional', await output.inputValue() === '1.2' && await provider.getByText(/No per-request bills are required/).isVisible());
  await page.screenshot({ path: `${out}/official-prices-prefilled.png`, animations: 'disabled' });
  await input.fill('0.4'); await output.fill('2');
  await provider.getByRole('button', { name: 'Save price snapshot', exact: true }).click();
  await waitUntil(async () => (await request('/cost/prices?providerId=pricing-openai')).some(price => price.source === 'user_confirmed' && price.modelId === 'gpt-5.6-luna'), 'one model override saved');
  await request('/fixture/pricing-sample', {});
  const final = await request(`/cost/rooms/${metadata.roomIds.work}`);
  const actual = final.invocations.find(item => item.logicalStepId === 'pricing-new-sample');
  check('One override automatically prices subsequent model calls', actual.status === 'priced' && actual.amount.atomic === '72500000');
  const historical = final.invocations.find(item => item.invocationId === 'pricing-example-0');
  check('History retains original unknown price facts while showing a current reference estimate', historical.status === 'unpriced' && historical.priceSnapshotId === null && historical.amount === null && historical.referenceEstimate.amount.atomic === '759950000');
  const unchanged = final.invocations.find(item => item.invocationId === frozen.invocationId);
  check('Updating one model leaves a prior frozen invocation price and amount unchanged', unchanged.priceSnapshotId === frozen.priceSnapshotId && unchanged.amount.atomic === frozen.amount.atomic);
  check('No renderer errors', errors.length === 0);
  check('No external browser requests', external.length === 0);
  writeFileSync(`${out}/checks.json`, JSON.stringify({ generatedAt: new Date().toISOString(), fixtureOnly: true, checks }, null, 2));
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, animations: 'disabled' }).catch(() => {});
  writeFileSync(`${out}/failure.txt`, `${error.stack ?? error}\n\n${await page.locator('body').innerText().catch(() => '')}`);
  throw error;
} finally { await browser.close(); }
