// Requires isolated README fixture on :45327 and Vite on :45328.
// SOCRATES_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/readme/capture.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 930 }, deviceScaleFactor: 1.5 });
page.setDefaultTimeout(15000);
const checks = [], errors = [];
page.on('pageerror', error => errors.push(String(error)));
const check = (name, ok) => { checks.push({ name, ok }); console.log(name, ok); if (!ok) throw Error(name); };
const settle = async () => page.evaluate(async () => {
  await document.fonts.ready;
  for (const animation of document.getAnimations()) {
    if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
const api = 'http://127.0.0.1:45327';
mkdirSync('output/playwright/personas', { recursive: true });
await page.addInitScript(() => {
  localStorage.setItem('socrates.lang', 'en');
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__TAURI_INTERNALS__ = {
    invoke: async cmd => cmd === 'sidecar_handshake' ? { port: 45327, token: 'ui-validation' } : null,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => 0, unregisterCallback() {},
  };
});
try {
  await page.request.put(`${api}/config`, { data: { language: 'en', theme: 'dark', appearance: { fontSize: 15, fontFamily: 'system', uiTheme: 'opencode-flat' } } });
  await page.goto('http://127.0.0.1:45328/', { waitUntil: 'networkidle' });
  await page.getByRole('textbox', { name: 'Task input', exact: true }).waitFor();
  await page.getByRole('complementary').getByText('Design a calmer inbox', { exact: true }).click();
  await page.getByText('Good challenge.', { exact: false }).waitFor();
  await page.getByRole('combobox', { name: 'Response mode', exact: true }).selectOption('discuss');
  await settle();
  await page.screenshot({ path: 'doc/assets/readme/chat.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Pixel agents', exact: true }).click();
  await page.getByRole('button', { name: '+ Create agent', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Create agent', exact: true });
  const name = () => editor.getByRole('textbox', { name: 'Chat nickname', exact: true });
  const portrait = () => editor.locator('.persona-editor__preview img');
  const source = () => portrait().getAttribute('src');
  const generated = await source();
  check('Generated avatar displayed as an image', generated.startsWith('data:image/svg+xml,'));
  check('Twelve generated options are labelled', await editor.getByRole('group', { name: 'Choose an avatar' }).getByRole('button').count() === 12);
  const fourth = await editor.getByRole('button', { name: 'Avatar 4', exact: true }).locator('img').getAttribute('src');
  await editor.getByRole('button', { name: 'Avatar 4', exact: true }).click();
  check('Selecting an avatar keeps the gallery order stable', fourth === await editor.getByRole('button', { name: 'Avatar 4', exact: true }).locator('img').getAttribute('src'));
  await editor.getByRole('button', { name: 'Avatar 1', exact: true }).click();
  check('Name starts in the application language', /^[A-Za-z ]+$/.test(await name().inputValue()));
  const firstName = await name().inputValue();
  await editor.getByRole('button', { name: '↻ New name', exact: true }).click();
  check('Name shuffle changes the name, not the avatar', firstName !== await name().inputValue() && generated === await source());
  await editor.getByRole('combobox', { name: 'Random name language' }).selectOption('zh-CN');
  check('Chinese name generation preserves the avatar', /^[\p{Script=Han}]+$/u.test(await name().inputValue()) && generated === await source());
  await editor.getByRole('combobox', { name: 'Random name language' }).selectOption('zh-TW');
  check('Traditional Chinese option generates a name', /^[\p{Script=Han}]+$/u.test(await name().inputValue()));
  await editor.getByRole('combobox', { name: 'Random name language' }).selectOption('en');
  const nameBeforeAvatar = await name().inputValue();
  await editor.getByRole('button', { name: '↻ New avatars', exact: true }).click();
  check('Avatar shuffle changes the image, not the name', generated !== await source() && nameBeforeAvatar === await name().inputValue());
  await editor.getByRole('button', { name: 'Classic characters', exact: true }).click();
  check('All six original portraits remain available', await editor.getByRole('group', { name: 'Choose an avatar' }).getByRole('button').count() === 6);
  await editor.getByRole('button', { name: 'Avatar 3', exact: true }).click();
  check('Classic avatar selection works', (await source()).endsWith('/avatars/owl-engineer.webp'));
  const files = editor.locator('input[type=file]');
  await files.setInputFiles({ name: 'invalid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await editor.getByRole('alert').getByText('Use a PNG, JPEG, WebP or GIF avatar.').waitFor();
  check('SVG upload is rejected without changing avatar', (await source()).endsWith('/avatars/owl-engineer.webp'));
  await files.setInputFiles({ name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await editor.getByRole('alert').getByText('The avatar must be 2MB or smaller.').waitFor();
  check('Oversized upload is rejected', true);
  await files.setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image') });
  await editor.getByRole('alert').getByText('The avatar file could not be read.').waitFor();
  check('Corrupt image is rejected after decoding', true);
  await files.setInputFiles('apps/desktop/public/avatars/cat-astronaut.webp');
  await page.waitForFunction(() => document.querySelector('.persona-editor__preview img')?.src.startsWith('data:image/webp;'));
  const uploaded = await source();
  await editor.getByRole('button', { name: '↻ New name', exact: true }).click();
  check('Name shuffle keeps a custom upload', uploaded === await source());
  await name().fill('Lunar Sage');
  check('Duplicate nickname disables saving', await editor.getByRole('button', { name: 'Create', exact: true }).isDisabled());
  await name().fill('Moss Scout');
  await editor.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('mock');
  await editor.getByRole('combobox', { name: /^Model \(blank = provider default\)/ }).selectOption('mock-model');
  await editor.getByRole('textbox', { name: 'Role', exact: true }).fill('Researcher · connect the dots');
  await editor.getByRole('textbox', { name: 'System prompt', exact: true }).fill('Explore the question from different angles. Make your assumptions explicit, ask useful questions, and build on the other members’ ideas.');
  await editor.getByRole('button', { name: 'Create', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const all = await (await page.request.get(`${api}/agents`)).json();
  const saved = all.find(agent => agent.nickname === 'Moss Scout');
  check('Uploaded image persists through the API', saved?.avatar === uploaded && saved.role.includes('Researcher'));
  await page.getByRole('article').filter({ hasText: 'Moss Scout' }).getByRole('button', { name: 'Edit', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Edit agent', exact: true });
  check('Saved custom image survives reopening the editor', uploaded === await source());
  // Slow a file read to verify that a newer selection wins.
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function(file) {
      setTimeout(() => { original.call(this, file); window.__avatarReadStarted = true; }, 400);
    };
    window.__restoreAvatarReader = () => { FileReader.prototype.readAsDataURL = original; };
  });
  await editor.locator('input[type=file]').setInputFiles('apps/desktop/public/avatars/cyber-fox.webp');
  await editor.getByRole('button', { name: '↻ New avatars', exact: true }).click();
  const chosen = await source();
  await page.waitForFunction(() => window.__avatarReadStarted);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 150)));
  check('A stale upload cannot overwrite a newer avatar choice', chosen === await source());
  await page.evaluate(() => window.__restoreAvatarReader());
  await page.setViewportSize({ width: 1280, height: 1200 });
  await editor.evaluate(element => { element.scrollTop = 0; });
  await settle();
  await editor.screenshot({ path: 'doc/assets/readme/character-editor.png', animations: 'disabled' });
  check('Avatar images decode successfully', await editor.locator('.persona-editor img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)));
  await page.setViewportSize({ width: 760, height: 620 });
  await settle();
  check('Editor fits the minimum desktop width', await editor.evaluate(element => element.scrollWidth <= element.clientWidth));
  await editor.screenshot({ path: 'output/playwright/personas/compact.png', animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 930 });
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  const resaved = (await (await page.request.get(`${api}/agents`)).json()).find(agent => agent.id === saved.id);
  check('Generated avatar also persists after editing', resaved.avatar.startsWith('identicon:v1:'));
  await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.getByRole('tab', { name: 'Work', exact: true }).click();
  await page.getByRole('complementary').getByText('Build a reading queue', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Response mode', exact: true }).selectOption('team');
  await page.getByRole('textbox', { name: 'Task input', exact: true }).fill('Build a local-first reading queue with save, read and archive actions. Split implementation and edge-case review between the team. Show me the plan before you begin.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: /Approve exact plan/ }).waitFor();
  await settle();
  await page.screenshot({ path: 'doc/assets/readme/work.png', animations: 'disabled' });
  check('No browser exceptions', errors.length === 0);
} catch (error) {
  writeFileSync('output/playwright/personas/failure.txt', `${error}\n${await page.locator('body').ariaSnapshot()}`);
  await page.screenshot({ path: 'output/playwright/personas/failure.png', animations: 'disabled' });
  throw error;
} finally {
  writeFileSync('output/playwright/personas/checks.json', JSON.stringify({ checks, errors }, null, 2));
  await browser.close();
}
