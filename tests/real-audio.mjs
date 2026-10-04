// Реальное распознавание: виртуальный микрофон PulseAudio (tests/vmic.sh) + синтезированная речь.
// node tests/real-audio.mjs <браузер> <engine: auto|vosk|google|google-local> <model: download|file|none> [wav] [lang]
import { launch, openExtension } from './launch.mjs';
import { startServers } from './server.mjs';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const [exe, engine = 'auto', model = 'file', wav = path.join(ROOT, 'tests/audio/ru1.wav'), lang = 'ru-RU'] = process.argv.slice(2);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms, step = 200) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; }
const tag = exe.includes('vivaldi') ? 'vivaldi' : exe.includes('google-chrome') ? 'chrome' : 'chromium';
const log = (...a) => console.log(`[${tag}/${engine}]`, ...a);

execSync(path.join(ROOT, 'tests/vmic.sh'));
const srv = await startServers();
const L = await launch(exe, { extensionDir: path.join(ROOT, 'extension'), extraArgs: ['--use-fake-ui-for-media-stream', '--window-size=1200,900', '--autoplay-policy=no-user-gesture-required'] });
const b = L.browser;
const { extId, page: opt } = await openExtension(b);
log('version', await b.version(), 'ext', extId, 'UA brands', JSON.stringify(await opt.evaluate(() => navigator.userAgentData && navigator.userAgentData.brands)));
await opt.click('#micGrant');
log('mic:', await waitFor(async () => { const t = await opt.$eval('#micState', e => e.textContent); return t.includes('разрешён') && t; }, 8000));
if (model !== 'none') {
  const t0 = Date.now();
  const row = `#voskBlock .model[data-lang="${lang}"]`;
  await opt.waitForSelector(row, { timeout: 10000 });
  if (model === 'download') await opt.click(`${row} button[data-action=download]`);
  else { const inp = await opt.$(`${row} input[type=file]`); await inp.uploadFile(path.join(ROOT, 'tools-dl/models/vosk-model-small-ru-0.22.zip')); }
  const ok = await waitFor(async () => (await opt.$eval(row, e => e.textContent)).includes('установлена ✓'), 180000, 500);
  log('model', model, ok ? 'installed' : 'FAILED', ((Date.now() - t0) / 1000).toFixed(1) + 's', await opt.$eval(row, e => e.textContent));
}
await opt.evaluate((engine, lang) => chrome.storage.local.set({ engine, lang, sounds: false, silenceStopSec: 0 }), engine, lang);
const state = () => opt.evaluate(async () => { const r = await chrome.runtime.sendMessage({ to: 'bg', type: 'get-state' }); return r && r.session ? r.session : null; });

const page = await b.newPage();
await page.goto(srv.url, { waitUntil: 'load' });
await sleep(800);
async function hotkey() { await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyV'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); }
const out = [];
for (let round = 1; round <= 2; round++) {
  await page.$eval('#ta', e => { e.value = ''; });
  await page.click('#ta');
  const t0 = Date.now();
  await hotkey();
  const ready = await waitFor(async () => { const s = await state(); return s && s.state === 'listening' && s; }, 90000, 250);
  const tReady = (Date.now() - t0) / 1000;
  log(`round ${round}: listening=${!!ready} engine=${ready && ready.engine} after ${tReady.toFixed(1)}s`);
  if (!ready) { const s = await state(); log('state:', JSON.stringify(s)); break; }
  await sleep(700);
  spawn('paplay', ['-d', 'vmic', wav]);
  const got = await waitFor(async () => { const v = await page.$eval('#ta', e => e.value); return v.length > 8 && /[?.!]$|дела|test|period/i.test(v) && v; }, 25000, 300);
  await sleep(2500);
  const value = await page.$eval('#ta', e => e.value);
  log(`round ${round}: text = ${JSON.stringify(value)}`);
  await page.screenshot({ path: path.join(ROOT, `tests/out/real-${tag}-${engine}-r${round}.png`), clip: { x: 0, y: 0, width: 1100, height: 330 } });
  out.push({ round, engine: ready.engine, readySec: tReady, text: value, recognized: !!got });
  await page.keyboard.press('Escape');
  await waitFor(async () => !(await state()), 12000);
  await sleep(800);
}
const errs = L.stderr().split('\n').filter(l => /vosk|speech|offscreen/i.test(l)).slice(-5);
if (errs.length) log('stderr:', errs.join('\n'));
fs.writeFileSync(path.join(ROOT, `tests/out/real-${tag}-${engine}.json`), JSON.stringify({ browser: await b.version(), engine, model, results: out }, null, 2));
await L.close(); srv.close();
process.exit(out.length && out.every(r => r.recognized) ? 0 : 1);
