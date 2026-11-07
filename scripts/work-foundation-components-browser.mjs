// Requires scripts/work-foundation-fixture.ts; this script refuses a real sidecar.
import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const metadata = JSON.parse(readFileSync('/private/tmp/socrates-work-foundation-fixture.json', 'utf8'));
if (metadata.source !== 'synthetic-work-foundation') throw new Error('Requires the controlled Work foundation fixture');
const baseUrl = `http://127.0.0.1:${metadata.port}`;
const request = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${metadata.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return response.json();
};
if (!(await request('/health')).controlledFixture) throw new Error('Refusing a real sidecar');
const originalConfig = await request('/config');
const countsBefore = await request('/__foundation/counts');
const originalMembers = (await request('/sessions')).find(room => room.id === metadata.roomIds.work)?.agents.map(member => member.agentId);
if (!originalMembers || originalMembers.includes('fixture-c')) throw new Error('Fixture must start without fixture-c in the Work room');

const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? '/Users/haosen/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1320, height: 1040 } });
page.setDefaultTimeout(12000);
page.setDefaultNavigationTimeout(45000);
const out = resolve('output/playwright/work-foundation-components');
mkdirSync(out, { recursive: true });
const checks = [], errors = [], external = [], readability = [];
let failure;
const check = (name, ok, detail) => {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) throw new Error(name);
};
const waitUntil = async (query, label) => {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const value = await query();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out: ${label}`);
};
const getRoom = async () => (await request('/sessions')).find(room => room.id === metadata.roomIds.work);
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    external.push(`${url.origin}${url.pathname}`);
    return route.abort();
  }
  return route.continue();
});
await page.addInitScript(({ port, token }) => {
  localStorage.clear();
  localStorage.setItem('socrates.lang', 'en');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    invoke: async command => command === 'sidecar_handshake' ? { port, token } : null,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => 0, unregisterCallback() {},
  };
}, metadata);

const words = {
  en: { members: 'Room members', picker: 'Choose a role to invite', create: 'Create agent', close: 'Dismiss', remove: 'Remove', confirm: 'Remove this room member?', cancel: 'Cancel', add: '+ Add', settings: 'Settings', bots: 'Bots' },
  'zh-CN': { members: '群成员', picker: '选择要邀请的角色', create: '创建 Agent', close: '关闭', remove: '移出', confirm: '移除此房间成员？', cancel: '取消', add: '+ 加入', settings: '设置', bots: '机器人' },
  'zh-TW': { members: '群成員', picker: '選擇要邀請的角色', create: '建立 Agent', close: '關閉', remove: '移出', confirm: '移除此房間成員？', cancel: '取消', add: '+ 加入', settings: '設定', bots: '機器人' },
};
const openRoom = async () => {
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  const sidebar = page.getByRole('complementary').first();
  const entry = sidebar.getByText('Foundation Work', { exact: true });
  if (!await entry.isVisible()) await sidebar.getByRole('button', { expanded: false }).first().click();
  await entry.click();
};
const openMembers = async (lang = 'en') => {
  const trigger = page.getByRole('button', { name: words[lang].members, exact: true }).first();
  await trigger.click();
  const modal = page.getByRole('dialog', { name: words[lang].members, exact: true });
  await modal.waitFor({ state: 'visible' });
  return { modal, trigger };
};
const screen = async name => page.screenshot({ path: `${out}/${name}.png`, animations: 'disabled' });
const focusWithin = async modal => modal.evaluate(element => element.contains(document.activeElement));
const measureReadability = async (modal, label) => {
  const values = await modal.evaluate(element => {
    const srgb = channel => (channel /= 255) <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    const luminance = rgb => .2126 * srgb(rgb[0]) + .7152 * srgb(rgb[1]) + .0722 * srgb(rgb[2]);
    const rgb = color => color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    const samples = [element.querySelector('h2'), element.querySelector('.foundation-field-label'), element.querySelector('input'), element.querySelector('.foundation-detail-panel__header p')].filter(Boolean);
    return samples.map(node => {
      const style = getComputedStyle(node);
      let parent = node, background;
      while (parent && !background) {
        const candidate = getComputedStyle(parent).backgroundColor;
        if (candidate !== 'rgba(0, 0, 0, 0)' && candidate !== 'transparent') background = candidate;
        parent = parent.parentElement;
      }
      const foreground = rgb(style.color), bg = rgb(background ?? 'rgb(255, 255, 255)');
      const a = luminance(foreground), b = luminance(bg);
      return { text: node.value ?? node.textContent, color: style.color, background, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    });
  });
  readability.push({ label, values });
  check(`${label} primary and muted foundation text contrast is at least 4.5:1`, values.length === 4 && values.every(item => item.contrast >= 4.5), values.map(item => Number(item.contrast.toFixed(2))));
};

try {
  await request('/config', { language: 'en', theme: 'dark', soundEnabled: false }, 'PUT');
  await page.goto('http://127.0.0.1:45348/', { waitUntil: 'domcontentloaded' });
  await openRoom();
  const { modal, trigger } = await openMembers();
  check('Work room Members opens the production Base UI detail drawer', await modal.evaluate(element => element.classList.contains('foundation-drawer')));
  await waitUntil(() => focusWithin(modal), 'initial focus in member drawer');
  check('Member drawer moves initial focus inside', await focusWithin(modal));
  await screen('01-members-dark');
  await measureReadability(modal, 'Dark theme');

  const picker = modal.getByRole('combobox', { name: words.en.picker, exact: true });
  await picker.fill('雪松');
  const candidate = page.getByRole('option', { name: /雪松编辑/ });
  await candidate.waitFor({ state: 'visible' });
  check('Chinese member search filters the real actor catalogue', await candidate.count() === 1);
  await picker.press('ArrowDown');
  await picker.press('Enter');
  check('Arrow keys and Enter select the searched role', (await picker.inputValue()).includes('雪松编辑'));
  check('Selection alone does not change room membership', !(await getRoom()).agents.some(member => member.agentId === 'fixture-c'));
  await picker.fill('');
  await picker.fill('雪松');
  await picker.dispatchEvent('compositionstart', { data: '雪' });
  await picker.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, which: 229, isComposing: true, bubbles: true });
  check('IME Enter does not select or submit an invitation', await modal.getByRole('button', { name: words.en.add, exact: true, includeHidden: true }).isDisabled() && !(await getRoom()).agents.some(member => member.agentId === 'fixture-c'));
  await picker.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 229, which: 229, isComposing: true, bubbles: true });
  check('IME Escape keeps both picker and member drawer open', await modal.isVisible() && await candidate.isVisible());
  await picker.dispatchEvent('compositionend', { data: '雪松' });
  await new Promise(resolve => setTimeout(resolve, 120));
  await picker.press('ArrowDown');
  await picker.press('Enter');
  await modal.getByRole('button', { name: words.en.add, exact: true }).click();
  await waitUntil(async () => (await getRoom()).agents.some(member => member.agentId === 'fixture-c'), 'fixture-c added by production action');
  check('Add to room persists selected actor through the real API', (await getRoom()).agents.some(member => member.agentId === 'fixture-c'));
  await waitUntil(() => modal.getByRole('button', { name: 'Remove', exact: true }).count().then(count => count === originalMembers.length + 1), 'new member rendered');
  const addedToast = page.locator('.foundation-notification').filter({ hasText: 'Member added to this room' });
  await addedToast.waitFor({ state: 'visible' });
  check('Successful authoritative invitation displays a polite notification', await addedToast.isVisible() && (await getRoom()).agents.some(member => member.agentId === 'fixture-c'));
  check('Notification appearance does not take focus from the member flow', !await addedToast.evaluate(element => element.contains(document.activeElement)));
  await screen('02-member-added');
  await addedToast.getByRole('button', { name: words.en.close, exact: true }).click();
  await addedToast.waitFor({ state: 'hidden' });
  check('The notification close action dismisses its message', await addedToast.count() === 0);

  const memberRow = modal.locator('div.flex.items-center.gap-3').filter({ hasText: '雪松编辑' });
  const remove = memberRow.getByRole('button', { name: words.en.remove, exact: true });
  await remove.click();
  const confirm = page.getByRole('dialog', { name: words.en.confirm, exact: true });
  await confirm.waitFor({ state: 'visible' });
  check('Removing a member requires the production confirmation dialog', await confirm.getByText(/Existing task snapshots/).isVisible());
  await screen('03-remove-confirmation');
  await confirm.getByRole('button', { name: words.en.cancel, exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  await waitUntil(() => remove.evaluate(element => element === document.activeElement), 'focus returned after cancelling removal');
  check('Cancelling preserves membership and returns focus to Remove', (await getRoom()).agents.some(member => member.agentId === 'fixture-c') && await remove.evaluate(element => element === document.activeElement));
  await remove.click();
  await confirm.getByRole('button', { name: words.en.remove, exact: true }).click();
  await waitUntil(async () => !(await getRoom()).agents.some(member => member.agentId === 'fixture-c'), 'fixture-c removed by production confirmation');
  await confirm.waitFor({ state: 'hidden' });
  check('Confirming removes only the selected fixture member', JSON.stringify((await getRoom()).agents.map(member => member.agentId).sort()) === JSON.stringify([...originalMembers].sort()));
  await waitUntil(() => focusWithin(modal), 'focus returned inside roster after confirmed removal');
  check('Confirmed removal restores focus inside the remaining roster', await focusWithin(modal));
  const removedToast = page.locator('.foundation-notification').filter({ hasText: 'Member removed from this room' });
  await removedToast.waitFor({ state: 'visible' });
  check('Confirmed authoritative removal displays its success notification', await removedToast.isVisible());
  await page.mouse.move(1, 1);
  await removedToast.waitFor({ state: 'hidden', timeout: 6500 });
  check('Unfocused success notification dismisses automatically', await removedToast.count() === 0);

  const close = modal.getByRole('button', { name: words.en.close, exact: true });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await waitUntil(() => focusWithin(modal), 'reverse Tab focus guard settled');
  check('Member drawer traps reverse Tab within the modal', await focusWithin(modal));
  const lastButton = modal.locator('button:not(:disabled)').last();
  await lastButton.focus();
  await page.keyboard.press('Tab');
  await waitUntil(() => focusWithin(modal), 'forward Tab focus guard settled');
  check('Member drawer traps forward Tab within the modal', await focusWithin(modal));

  const create = modal.getByRole('button', { name: `+ ${words.en.create}`, exact: true });
  await create.click();
  const editor = page.getByRole('dialog', { name: words.en.create, exact: true });
  await editor.waitFor({ state: 'visible' });
  check('Nested member Create agent editor stays visible and receives focus', await editor.isVisible() && await focusWithin(editor));
  await screen('04-nested-agent-editor');
  check('Nested member editor is above its parent drawer and backdrop', await editor.evaluate(element => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + Math.min(50, box.height / 2)));
  }));
  check('Nested member editor is not aria-hidden or inert', await editor.evaluate(element => !element.closest('[aria-hidden="true"], [inert]')));
  await editor.getByRole('button', { name: words.en.close, exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await waitUntil(() => focusWithin(editor), 'nested editor reverse focus trap');
  check('Nested member editor traps keyboard focus inside its own panel', await focusWithin(editor));
  await editor.getByRole('button', { name: words.en.close, exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  check('Cancelling nested AgentEditor preserves the member drawer', await modal.isVisible());
  await waitUntil(() => create.evaluate(element => element === document.activeElement), 'focus returned to Create agent');
  check('Nested editor returns focus to Create agent', await create.evaluate(element => element === document.activeElement));
  await close.click();
  await modal.waitFor({ state: 'hidden' });
  await waitUntil(() => trigger.evaluate(element => element === document.activeElement), 'focus returned to Members');
  check('Closing member drawer returns focus to its Members trigger', await trigger.evaluate(element => element === document.activeElement));

  await page.getByRole('button', { name: words.en.settings, exact: true }).click();
  const settings = page.getByRole('dialog', { name: words.en.settings, exact: true });
  await settings.getByRole('button', { name: words.en.bots, exact: true }).click();
  const settingsCreate = settings.getByRole('button', { name: `+ ${words.en.create}`, exact: true });
  await settingsCreate.click();
  await editor.waitFor({ state: 'visible' });
  check('Existing Settings to AgentEditor path still opens and receives focus', await editor.isVisible() && await focusWithin(editor));
  await screen('05-settings-agent-editor');
  await editor.getByRole('button', { name: words.en.close, exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  check('Cancelling Settings AgentEditor preserves Settings', await settings.isVisible());
  await settings.getByRole('button', { name: words.en.close, exact: true }).click();
  await settings.waitFor({ state: 'hidden' });

  for (const lang of ['en', 'zh-CN', 'zh-TW']) {
    await request('/config', { language: lang, theme: lang === 'zh-TW' ? 'light' : 'dark' }, 'PUT');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openRoom();
    const { modal: translated } = await openMembers(lang);
    check(`${lang} member picker, create action and close action are localized`, await translated.getByRole('combobox', { name: words[lang].picker, exact: true }).isVisible() && await translated.getByRole('button', { name: `+ ${words[lang].create}`, exact: true }).isVisible() && await translated.getByRole('button', { name: words[lang].close, exact: true }).isVisible());
    if (lang === 'zh-TW') await measureReadability(translated, 'Light theme');
    await screen(`06-language-${lang}`);
    await translated.getByRole('button', { name: words[lang].close, exact: true }).click();
    await translated.waitFor({ state: 'hidden' });
  }

  const after = await request('/__foundation/counts');
  check('Roster editing and UI inspection trigger zero additional gateway or native executions', after.gateway === countsBefore.gateway && after.native === countsBefore.native, { before: countsBefore, after });
  check('No renderer or console errors', errors.length === 0, errors);
  check('No external browser requests', external.length === 0, external);
  rmSync(`${out}/failure.txt`, { force: true });
  rmSync(`${out}/failure.png`, { force: true });
} catch (error) {
  failure = String(error.stack ?? error);
  await screen('failure').catch(() => {});
  writeFileSync(`${out}/failure.txt`, `${failure}\n\nFocused element: ${await page.evaluate(() => document.activeElement?.outerHTML).catch(() => '')}\n\n${await page.locator('body').innerText().catch(() => '')}`);
  console.error(failure);
} finally {
  await request('/config', { language: originalConfig.language, theme: originalConfig.theme, soundEnabled: originalConfig.soundEnabled }, 'PUT').catch(error => { errors.push(`Configuration cleanup: ${error}`); });
  if ((await getRoom()).agents.some(member => member.agentId === 'fixture-c')) {
    await request(`/sessions/${metadata.roomIds.work}/agents/fixture-c`, undefined, 'DELETE').catch(error => { errors.push(`Membership cleanup: ${error}`); });
  }
  writeFileSync(`${out}/checks.json`, JSON.stringify({ generatedAt: new Date().toISOString(), source: metadata.source, browser: 'Chrome', fixtureOnly: true, success: !failure && !errors.length && !external.length, checks, readability, errors, external, ...(failure ? { failure } : {}) }, null, 2));
  await browser.close();
}
if (failure || errors.length || external.length) process.exitCode = 1;
