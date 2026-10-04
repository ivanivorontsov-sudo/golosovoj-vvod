// Сквозные тесты «Голосового ввода» с тестовым (mock) движком распознавания.
// Запуск: xvfb-run -a node tests/e2e.mjs [путь-к-браузеру]
import { launch, openExtension } from './launch.mjs';
import { startServers } from './server.mjs';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const EXT = path.join(ROOT, 'extension');
const OUT = path.join(ROOT, 'tests', 'out'); fs.mkdirSync(OUT, { recursive: true });
const exe = process.argv[2] || fs.readdirSync(path.join(process.env.HOME, '.cache/ms-playwright')).filter(d => /^chromium-\d+/.test(d)).map(d => path.join(process.env.HOME, '.cache/ms-playwright', d, 'chrome-linux64/chrome'))[0];
const tag = path.basename(path.dirname(exe)).includes('vivaldi') || exe.includes('vivaldi') ? 'vivaldi' : exe.includes('google-chrome') ? 'chrome' : 'chromium';

const results = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms = 6000, step = 100) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(step); }
  return false;
}

const srv = await startServers();
const L = await launch(exe, { extensionDir: EXT, extraArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--window-size=1200,1000'] });
const b = L.browser;
// id расширения — по странице настроек, которую расширение открывает при установке
const { extId, page: ctlPage } = await openExtension(b);
// управляющая вкладка (страница расширения): storage и состояние сессии
const ctl = ctlPage;
const ctlEval = (fn, ...args) => ctl.evaluate(fn, ...args);
async function getSW() {
  await ctlEval(() => chrome.runtime.sendMessage({ to: 'bg', type: 'get-state' }));
  const t = await b.waitForTarget(t => t.type() === 'service_worker' && t.url() === `chrome-extension://${extId}/background.js`, { timeout: 15000 });
  return t.worker();
}
const swEval = async (fn, ...args) => { const w = await getSW(); return w.evaluate(fn, ...args); };
console.log('browser:', tag, await b.version(), 'extension id:', extId);

const page = await b.newPage();
await page.setViewport({ width: 1100, height: 1400 });
const consoleErrors = [];
let currentTest = '';
page.on('pageerror', e => consoleErrors.push(currentTest + ': ' + String(e)));
await page.goto(srv.url, { waitUntil: 'load' });
await page.waitForFunction(() => window.quill && window.pmView && window.lexicalEditor && window.draftText, { timeout: 15000 });
await sleep(800);

const setMock = (script, extra = {}) => ctlEval((s, e) => chrome.storage.local.set(Object.assign({ engine: 'mock', mockScript: s, silenceStopSec: 0, sounds: false }, e)), script, extra);
const sessionState = () => ctlEval(async () => { const r = await chrome.runtime.sendMessage({ to: 'bg', type: 'get-state' }); return r && r.session ? r.session.state : 'none'; });
async function hotkey() { await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyV'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); }
async function stopAndWait() {
  if ((await sessionState()) !== 'none') { await sleep(500); await page.keyboard.press('Escape'); }
  await waitFor(async () => (await sessionState()) === 'none', 12000);
  await sleep(550);
}
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
async function test(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
  currentTest = name;
  console.log('  state before', name, await sessionState());
  const t0 = Date.now();
  try { const r = await fn(); results.push({ name, ok: r.ok, got: r.got, want: r.want, ms: Date.now() - t0 }); }
  catch (e) { results.push({ name, ok: false, got: 'EXCEPTION ' + (e.stack || e).toString().slice(0, 300), ms: Date.now() - t0 }); }
  const r = results[results.length - 1];
  console.log((r.ok ? 'PASS ' : 'FAIL ') + name + (r.ok ? '' : `\n     want: ${JSON.stringify(r.want)}\n     got:  ${JSON.stringify(r.got)}`));
  try { await stopAndWait(); } catch {}
}
// диктует фразы в поле и сравнивает результат
const dbg = (m) => { if (process.env.DEBUG) console.log('   ', new Date().toISOString().slice(11, 19), m); };
async function dictate({ focus, read, script, want, start = hotkey, cmp = (a, b) => a === b, shot }) {
  await setMock(script); dbg('mock set');
  await focus(); dbg('focused');
  await sleep(150);
  await start(); dbg('started');
  const ok = await waitFor(async () => cmp(await read(), want), 7000);
  if (shot) await page.screenshot({ path: path.join(OUT, `${tag}-${shot}.png`) });
  return { ok: !!ok, got: await read(), want };
}
const frameBy = (pred) => page.frames().find(pred);
const clickSel = (sel) => async () => { await page.click(sel); };

await test('input: команды пунктуации и заглавная буква', () => dictate({
  focus: clickSel('#inp'), read: () => page.$eval('#inp', e => e.value),
  script: [{ interim: 'привет' }, { interim: 'привет запятая мир' }, { final: 'привет запятая мир точка' }], want: 'Привет, мир.'
}));
await test('input: вставка в позицию курсора', () => dictate({
  focus: async () => { await page.click('#inp-caret'); await page.$eval('#inp-caret', e => e.setSelectionRange(5, 5)); },
  read: () => page.$eval('#inp-caret', e => e.value), script: [{ final: 'big' }], want: 'Hello big world'
}));
await test('input type=email', () => dictate({
  focus: clickSel('#email'), read: () => page.$eval('#email', e => e.value), script: [{ final: 'test' }], want: 'Test'
}));
await test('textarea: «новая строка» и продолжение после точки', () => dictate({
  focus: async () => { await page.click('#ta'); await page.$eval('#ta', e => e.setSelectionRange(e.value.length, e.value.length)); },
  read: () => page.$eval('#ta', e => e.value), script: [{ final: 'новая строка вторая строка' }, { final: 'и ещё немного вопросительный знак', delay: 300 }],
  want: 'Строка один.\nВторая строка и ещё немного?'
}));
await test('contenteditable: «!» и «новый абзац»', () => dictate({
  focus: clickSel('#ce'), read: () => page.$eval('#ce', e => e.innerText.replace(/\n+/g, '\n').trim()),
  script: [{ final: 'проверка восклицательный знак' }, { final: 'новый абзац это второй абзац', delay: 300 }], want: 'Проверка!\nЭто второй абзац', shot: 'contenteditable'
}));
await test('iframe того же источника', async () => {
  const fr = frameBy(f => f.url().startsWith(srv.url) && f.url().endsWith('/frame.html'));
  return dictate({ focus: () => fr.click('#f-inp'), read: () => fr.$eval('#f-inp', e => e.value), script: [{ final: 'текст во фрейме' }], want: 'Текст во фрейме' });
});
await test('iframe другого источника (OOPIF)', async () => {
  const fr = frameBy(f => f.url().startsWith('http://127.0.0.1:'));
  return dictate({ focus: () => fr.click('#f-ta'), read: () => fr.$eval('#f-ta', e => e.value), script: [{ final: 'чужой фрейм точка' }], want: 'Чужой фрейм.' });
});
await test('iframe с designMode', async () => {
  const fr = frameBy(f => f.url() === 'about:srcdoc');
  return dictate({ focus: () => fr.click('body'), read: () => fr.evaluate(() => document.body.innerText.trim()), script: [{ final: 'режим дизайна' }], want: 'Режим дизайна' });
});
await test('shadow DOM: input', () => dictate({
  focus: async () => { const h = await page.evaluateHandle(() => document.querySelector('#shadow-host').shadowRoot.querySelector('#s-inp')); await h.click(); },
  read: () => page.evaluate(() => document.querySelector('#shadow-host').shadowRoot.querySelector('#s-inp').value), script: [{ final: 'теневой dom' }], want: 'Теневой dom'
}));
await test('shadow DOM: contenteditable', () => dictate({
  focus: async () => { const h = await page.evaluateHandle(() => document.querySelector('#shadow-host').shadowRoot.querySelector('#s-ce')); await h.click(); },
  read: () => page.evaluate(() => document.querySelector('#shadow-host').shadowRoot.querySelector('#s-ce').innerText.trim()), script: [{ final: 'редактор в тени двоеточие да' }], want: 'Редактор в тени: да'
}));
await test('React controlled input (состояние React обновилось)', () => dictate({
  focus: clickSel('#react-inp'), read: () => page.$eval('#react-mirror', e => e.textContent), script: [{ final: 'реакт видит текст' }], want: 'Реакт видит текст'
}));
await test('Quill', () => dictate({
  focus: clickSel('#quill .ql-editor'), read: () => page.evaluate(() => window.quillText()), script: [{ final: 'квилл запятая работает' }], want: 'Квилл, работает'
}));
await test('ProseMirror', () => dictate({
  focus: clickSel('#pm .ProseMirror'), read: () => page.evaluate(() => window.pmText()), script: [{ final: 'просемиррор работает точка' }], want: 'Просемиррор работает.'
}));
await test('Lexical', () => dictate({
  focus: clickSel('#lexical'), read: () => page.evaluate(() => window.lexText()), script: [{ final: 'лексикал работает' }], want: 'Лексикал работает'
}));
await test('Draft.js', () => dictate({
  focus: clickSel('#draft .public-DraftEditor-content'), read: () => page.evaluate(() => window.draftText()), script: [{ final: 'драфт работает' }, { final: 'и дальше точка', delay: 400 }], want: 'Драфт работает и дальше.'
}));
await test('Draft.js: редактор жив после вставки, без ошибок React', async () => {
  const alive = await page.$('#draft .public-DraftEditor-content');
  const errs = consoleErrors.filter(e => e.startsWith('Draft.js'));
  return { ok: !!alive && errs.length === 0, got: { alive: !!alive, errs }, want: { alive: true, errs: [] } };
});
await test('голосовая команда «удали последнее»', () => dictate({
  focus: async () => { await page.click('#inp'); await page.$eval('#inp', e => { e.select(); }); await page.keyboard.press('Backspace'); },
  read: () => page.$eval('#inp', e => e.value),
  script: [{ final: 'первая фраза' }, { final: 'вторая фраза', delay: 400 }, { final: 'удали последнее', delay: 600 }],
  cmp: (a, b) => a === b, want: 'Первая фраза'
}));
await test('голосовая команда «стоп запись» останавливает диктовку', async () => {
  await setMock([{ final: 'стоп запись' }]);
  await page.click('#inp'); await sleep(100); await hotkey();
  await waitFor(async () => (await sessionState()) !== 'none', 3000);
  const stopped = await waitFor(async () => (await sessionState()) === 'none', 8000);
  return { ok: !!stopped, got: await sessionState(), want: 'none' };
});
await test('кнопка 🎤 у поля запускает диктовку (фокус остаётся в поле)', async () => {
  await page.$eval('#inp', e => { e.value = ''; });
  return dictate({
    focus: clickSel('#inp'),
    start: async () => { const r = await page.$eval('#inp', e => { const b = e.getBoundingClientRect(); return { x: b.right - 19, y: b.top + b.height / 2 }; }); await page.mouse.click(r.x, r.y); },
    read: () => page.$eval('#inp', e => e.value), script: [{ interim: 'кнопка' }, { final: 'кнопка работает', delay: 900 }], want: 'Кнопка работает', shot: 'mic-button'
  });
});
await test('индикатор записи: промежуточный текст (скриншот)', async () => {
  await setMock([{ interim: 'это промежуточный результат', delay: 100 }, { final: 'готово', delay: 4000 }]);
  await page.click('#ta'); await sleep(100); await hotkey();
  await sleep(1500);
  await page.screenshot({ path: path.join(OUT, `${tag}-indicator.png`), clip: { x: 0, y: 0, width: 1100, height: 420 } });
  const st = await sessionState();
  return { ok: st === 'listening', got: st, want: 'listening' };
});
await test('без поля ввода диктовка не стартует (подсказка)', async () => {
  await setMock([{ final: 'не должно вставиться' }]);
  await page.click('h3'); await page.evaluate(() => document.activeElement && document.activeElement.blur());
  // сбросим «последнее поле», как будто пользователь кликнул по пустому месту новой страницы
  await page.reload({ waitUntil: 'load' }); await sleep(800); await page.click('h3');
  await hotkey(); await sleep(1500);
  const st = await sessionState();
  if (process.env.DEBUG) console.log('DEBUG session', JSON.stringify(await ctlEval(async () => (await chrome.runtime.sendMessage({ to: 'bg', type: 'get-state' })).session)), 'page tab url', page.url(), 'active el', await page.evaluate(() => document.activeElement && document.activeElement.tagName), 'tabs', JSON.stringify(await ctlEval(async () => (await chrome.tabs.query({})).map(t => [t.id, t.active, t.url]))));
  return { ok: st === 'none', got: st, want: 'none' };
});
await test('повторное нажатие горячей клавиши останавливает запись', async () => {
  await page.waitForFunction(() => window.quill, { timeout: 15000 });
  await setMock([{ final: 'раз' }]);
  await page.click('#inp'); await sleep(100); await hotkey();
  await waitFor(async () => (await sessionState()) === 'listening', 4000);
  await sleep(600); await hotkey();
  const ok = await waitFor(async () => (await sessionState()) === 'none', 8000);
  return { ok: !!ok, got: await sessionState(), want: 'none' };
});
await test('значок расширения запускает диктовку (chrome.action)', async () => {
  await page.$eval('#inp', e => { e.value = ''; });
  return dictate({
    focus: clickSel('#inp'),
    start: async () => { await swEval(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await toggle(t.id, undefined); }); },
    read: () => page.$eval('#inp', e => e.value), script: [{ final: 'через значок' }], want: 'Через значок'
  });
});

// страница настроек: микрофон + поле «Проверка» (контент-скрипт на странице расширения)
const opt = await b.newPage();
await opt.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
await test('настройки: разрешение микрофона', async () => {
  await opt.click('#micGrant');
  const ok = await waitFor(async () => (await opt.$eval('#micState', e => e.textContent)).includes('разрешён'), 5000);
  await opt.screenshot({ path: path.join(OUT, `${tag}-options.png`), fullPage: true });
  return { ok: !!ok, got: await opt.$eval('#micState', e => e.textContent), want: 'разрешён' };
});
await test('настройки: диктовка в поле «Проверка»', async () => {
  await setMock([{ final: 'проверка на странице настроек' }]);
  await opt.bringToFront();
  await opt.click('#tryArea'); await sleep(150);
  await opt.keyboard.down('Alt'); await opt.keyboard.down('Shift'); await opt.keyboard.press('KeyV'); await opt.keyboard.up('Shift'); await opt.keyboard.up('Alt');
  const ok = await waitFor(async () => (await opt.$eval('#tryArea', e => e.value)) === 'Проверка на странице настроек', 6000);
  const got = await opt.$eval('#tryArea', e => e.value);
  await sleep(300); await opt.keyboard.press('Escape');
  await waitFor(async () => (await sessionState()) === 'none', 8000);
  return { ok: !!ok, got, want: 'Проверка на странице настроек' };
});

const passed = results.filter(r => r.ok).length;
console.log(`\n${tag}: ${passed}/${results.length} passed`);
if (consoleErrors.length) console.log('page errors:', consoleErrors.slice(0, 5));
fs.writeFileSync(path.join(OUT, `e2e-${tag}.json`), JSON.stringify({ browser: await b.version(), results }, null, 2));
await L.close(); srv.close();
process.exit(passed === results.length ? 0 : 1);
