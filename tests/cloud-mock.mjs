// Тест движка Google Cloud: реальная речь с виртуального микрофона → VAD → POST на локальный
// мок speech:recognize (проверяет формат запроса как у Google API v1) → вставка в поле.
import { launch, openExtension } from './launch.mjs';
import { startServers } from './server.mjs';
import { spawn, execSync } from 'node:child_process';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const exe = process.argv[2];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms, step = 200) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return false; }
const requests = [];
const mock = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type'); res.setHeader('Access-Control-Allow-Methods', 'POST');
  if (req.method === 'OPTIONS') return res.end();
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const j = JSON.parse(body);
    const audio = Buffer.from(j.audio.content, 'base64');
    // сохраняем присланный звук, чтобы проверить, что это правильный LINEAR16 16 кГц
    const f = path.join(ROOT, `tests/out/cloud-seg-${requests.length}.raw`); fs.writeFileSync(f, audio);
    requests.push({ key: u.searchParams.get('key'), config: j.config, seconds: audio.length / 2 / 16000 });
    res.setHeader('content-type', 'application/json');
    if (u.searchParams.get('key') !== 'TEST-KEY') { res.statusCode = 400; return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } })); }
    res.end(JSON.stringify({ results: [{ alternatives: [{ transcript: 'привет запятая как у тебя дела вопросительный знак', confidence: 0.9 }] }] }));
  });
}).listen(0);
const mockUrl = `http://127.0.0.1:${mock.address().port}/v1/speech:recognize`;
execSync(path.join(ROOT, 'tests/vmic.sh'));
const srv = await startServers();
const L = await launch(exe, { extensionDir: path.join(ROOT, 'extension'), extraArgs: ['--use-fake-ui-for-media-stream'] });
const { page: opt } = await openExtension(L.browser);
await opt.click('#micGrant'); await sleep(1500);
await opt.evaluate((u) => chrome.storage.local.set({ engine: 'google-cloud', cloudApiKey: 'TEST-KEY', cloudEndpoint: u, sounds: false, silenceStopSec: 0 }), mockUrl);
const page = await L.browser.newPage();
await page.goto(srv.url, { waitUntil: 'load' }); await sleep(600);
await page.click('#ta'); await page.$eval('#ta', e => { e.value = ''; });
await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyV'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
await sleep(1500);
console.log('session', JSON.stringify(await opt.evaluate(async () => (await chrome.runtime.sendMessage({ to: 'bg', type: 'get-state' })).session)));
const offT = L.browser.targets().find(t => t.url().includes('offscreen.html')); console.log('offscreen target', offT && offT.type());
if (offT) { const s2 = await offT.asPage().catch(()=>null) || null; if (s2) s2.on('console', m => console.log('OFF:', m.text())); }
spawn('paplay', ['-d', 'vmic', path.join(ROOT, 'tests/audio/ru1.wav')]);
const ok = await waitFor(async () => (await page.$eval('#ta', e => e.value)) === 'Привет, как у тебя дела?', 20000);
const value = await page.$eval('#ta', e => e.value);
await page.keyboard.press('Escape'); await sleep(1500);
// неверный ключ → понятная ошибка
await opt.evaluate(() => chrome.storage.local.set({ cloudApiKey: 'WRONG' }));
await page.click('#ta');
await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('KeyV'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
await sleep(1200); spawn('paplay', ['-d', 'vmic', path.join(ROOT, 'tests/audio/ru1.wav')]);
const errState = await waitFor(async () => { const r = await opt.evaluate(async () => (await chrome.runtime.sendMessage({ to: 'bg', type: 'get-state' })).session); return !r && requests.length >= 2; }, 20000);
await page.screenshot({ path: path.join(ROOT, 'tests/out/cloud-bad-key.png'), clip: { x: 0, y: 0, width: 1100, height: 1000 } });
console.log(JSON.stringify({ ok: !!ok, value, requests, badKeyStopsSession: !!errState }, null, 1));
fs.writeFileSync(path.join(ROOT, 'tests/out/cloud-mock.json'), JSON.stringify({ ok: !!ok, value, requests, badKeyStopsSession: !!errState }, null, 2));
await L.close(); srv.close(); mock.close(); process.exit(ok && errState ? 0 : 1);
