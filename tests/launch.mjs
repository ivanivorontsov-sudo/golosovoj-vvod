// Launch a Chromium-based browser (Chrome / Vivaldi / Chromium) with a CDP port and connect via puppeteer-core.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
export async function launch(exe, { extensionDir, extraArgs = [], headless = false, profileDir, keepProfile = false } = {}) {
  const profile = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'gv-prof-'));
  if (profileDir) fs.mkdirSync(profileDir, { recursive: true });
  const port = 9400 + Math.floor(Math.random() * 500);
  const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch', ...extraArgs];
  if (extensionDir) args.push(`--load-extension=${extensionDir}`, `--disable-extensions-except=${extensionDir}`);
  if (headless) args.push('--headless=new');
  args.push('about:blank');
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', d => { err += d; if (err.length > 40000) err = err.slice(-20000); });
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 30000 }); } catch {}
  }
  if (!browser) { proc.kill('SIGKILL'); throw new Error('cannot connect: ' + err.slice(-2000)); }
  const close = async () => { try { await browser.close(); } catch {} proc.kill('SIGKILL'); await new Promise(r => setTimeout(r, 500)); if (!keepProfile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} } };
  return { browser, close, port, profile, stderr: () => err };
}

// Находит наше расширение (id) и открывает его страницу настроек.
export async function openExtension(browser, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ids = [...new Set(browser.targets().map(t => t.url()).filter(u => u.startsWith('chrome-extension://')).map(u => new URL(u).host))];
    const welcome = browser.targets().find(t => t.type() === 'page' && /\/options\/options\.html/.test(t.url()));
    if (welcome) { const page = await welcome.page(); if (page) return { extId: new URL(welcome.url()).host, page }; }
    for (const id of ids) {
      if (browser.targets().some(t => t.url() === `chrome-extension://${id}/background.js`)) {
        const page = await browser.newPage();
        await page.goto(`chrome-extension://${id}/options/options.html`, { waitUntil: 'load' }).catch(() => {});
        if ((await page.title().catch(() => '')).startsWith('Голосовой ввод')) return { extId: id, page };
        await page.close();
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('extension not found');
}
