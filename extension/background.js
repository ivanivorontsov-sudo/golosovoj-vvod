/* Service worker «Голосового ввода»: горячие клавиши, кнопка на панели, маршрутизация между
   offscreen-документом (микрофон/распознавание) и полем ввода во вкладке (content script). */
'use strict';
importScripts('common/defaults.js');

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let session = null;           // { sid, tabId, frameId, lang, engine, state, extPage }
let lastToggle = 0;
const focusByTab = new Map(); // tabId -> frameId последнего поля ввода

async function getSettings() {
  const s = await chrome.storage.local.get(null);
  return Object.assign({}, GV_DEFAULTS, s);
}
async function saveSession() { try { await chrome.storage.session.set({ gvSession: session, gvFocus: [...focusByTab] }); } catch {} }
async function loadSession() {
  if (session) return;
  try {
    const { gvSession, gvFocus } = await chrome.storage.session.get(['gvSession', 'gvFocus']);
    if (gvSession) session = gvSession;
    if (gvFocus) for (const [t, f] of gvFocus) if (!focusByTab.has(t)) focusByTab.set(t, f);
  } catch {}
}

/* ---------- значок ---------- */
async function setBadge(state, lang) {
  const map = {
    idle: { text: '', color: '#666', title: 'Голосовой ввод — нажмите, чтобы диктовать (Alt+Shift+V)' },
    starting: { text: '…', color: '#f59e0b', title: 'Голосовой ввод: подключаю микрофон…' },
    listening: { text: (lang || 'ru').slice(0, 2).toUpperCase(), color: '#dc2626', title: 'Идёт запись — нажмите, чтобы остановить' },
    error: { text: '!', color: '#b45309', title: 'Голосовой ввод: ошибка — откройте настройки' }
  };
  const m = map[state] || map.idle;
  try {
    await chrome.action.setBadgeText({ text: m.text });
    await chrome.action.setBadgeBackgroundColor({ color: m.color });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    await chrome.action.setTitle({ title: m.title });
  } catch {}
}

/* ---------- offscreen ---------- */
let creatingOffscreen = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
    if (ctx.length) return;
  }
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Запись с микрофона для голосового ввода текста'
  }).catch(e => { if (!/single offscreen|already/i.test(String(e))) throw e; })
    .finally(() => { creatingOffscreen = null; });
  return creatingOffscreen;
}
function toOffscreen(msg) { return chrome.runtime.sendMessage(Object.assign({ to: 'offscreen' }, msg)).catch(() => null); }

/* ---------- связь с вкладкой ---------- */
async function toTab(tabId, frameId, msg) {
  msg = Object.assign({ to: 'cs' }, msg);
  if (session && session.extPage && session.tabId === tabId) {
    return chrome.runtime.sendMessage(Object.assign({ forTab: tabId }, msg)).catch(() => null);
  }
  try {
    return await chrome.tabs.sendMessage(tabId, msg, frameId === undefined || frameId === null ? undefined : { frameId });
  } catch { return null; }
}

/* ---------- порядок движков ---------- */
function engineOrder(s, lang) {
  if (s.engine && s.engine !== 'auto') return [s.engine];
  const order = [];
  const stale = !s.webspeechCheckedAt || (Date.now() - s.webspeechCheckedAt > 3 * 24 * 3600e3);
  if (s.webspeechStatus !== 'unavailable' || stale) order.push('google');
  if (s.cloudApiKey) order.push('google-cloud');
  order.push('vosk');
  return order;
}

/* ---------- старт / стоп ---------- */
async function toggle(tabId, frameId, opts = {}) {
  await loadSession();
  const now = Date.now();
  if (now - lastToggle < 450) return;      // защита от двойного срабатывания (команда + клавиша на странице)
  lastToggle = now;
  if (session && session.state !== 'stopped') { await stopSession('user'); return; }
  await startSession(tabId, frameId, opts);
}

async function startSession(tabId, frameId, opts = {}) {
  if (tabId === undefined || tabId === null) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) return;
    tabId = tab.id;
  }
  const extPage = !!opts.extPage;
  if (frameId === undefined || frameId === null) frameId = focusByTab.has(tabId) ? focusByTab.get(tabId) : 0;
  const s = await getSettings();
  const lang = s.lang || 'ru-RU';
  const sid = Date.now();
  session = { sid, tabId, frameId, lang, engine: null, state: 'starting', extPage };
  // поле ввода в фокусе?
  const probe = await toTab(tabId, frameId, { type: 'prepare', sid, lang });
  if (!probe || !probe.hasField) {
    // кнопка на панели могла «украсть» фокус у фрейма — пробуем все фреймы
    const any = extPage ? null : await findFocusedFrame(tabId, sid, lang);
    if (any === null) {
      session = null; await saveSession();
      if (probe === null && !extPage) {
        // контент-скрипта нет (служебная страница vivaldi://, магазин расширений, PDF)
        await setBadge('error');
        setTimeout(() => setBadge('idle'), 2500);
      } else {
        await toTab(tabId, frameId, { type: 'toast', text: 'Поставьте курсор в текстовое поле и повторите (Alt+Shift+V)' });
      }
      return;
    }
    session.frameId = frameId = any;
  }
  focusByTab.set(tabId, frameId);
  await saveSession();
  await setBadge('starting', lang);
  await toTab(tabId, frameId, { type: 'state', state: 'starting', lang, sid });
  try { await ensureOffscreen(); }
  catch (e) {
    await failSession('offscreen', 'Не удалось запустить распознавание: ' + (e.message || e));
    return;
  }
  const mock = opts.mock || (s.engine === 'mock' ? s.mockScript : null);
  const order = mock ? ['mock'] : engineOrder(s, lang);
  const ok = await toOffscreen({ type: 'start', sid, lang, order, settings: s, mock: mock || null });
  if (!ok) { await failSession('offscreen', 'Offscreen-документ не отвечает'); }
}

async function findFocusedFrame(tabId, sid, lang) {
  // спрашиваем все фреймы; отвечает только тот, где есть активное поле (он же сообщает свой frameId через 'focus')
  focusByTab.delete(tabId);
  let r = null;
  try { r = await chrome.tabs.sendMessage(tabId, { to: 'cs', type: 'prepare', sid, lang, strict: true }); } catch {}
  if (r && r.hasField) return focusByTab.has(tabId) ? focusByTab.get(tabId) : 0;
  return null;
}

async function stopSession(reason) {
  if (!session) return;
  const s = session;
  s.state = 'stopping';
  await toOffscreen({ type: 'stop', reason });
  await toTab(s.tabId, s.frameId, { type: 'state', state: 'stopping', sid: s.sid });
  // окончательное 'stopped' придёт из offscreen; страховка на случай, если offscreen уже закрыт
  setTimeout(async () => { if (session && session.sid === s.sid) await finishSession(reason); }, 10000);
}

async function finishSession(reason) {
  const s = session;
  session = null; await saveSession();
  await setBadge('idle');
  if (s) await toTab(s.tabId, s.frameId, { type: 'state', state: 'idle', reason, sid: s.sid });
}

async function failSession(code, message) {
  const s = session;
  session = null; await saveSession();
  await setBadge('error');
  setTimeout(() => { if (!session) setBadge('idle'); }, 4000);
  if (s) await toTab(s.tabId, s.frameId, { type: 'error', code, message, sid: s.sid });
  if (code === 'mic-denied') {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#mic') });
  }
}

/* ---------- события offscreen ---------- */
async function onEngineEvent(m) {
  await loadSession();
  if (!session || m.sid !== session.sid) {
    if (m.event === 'webspeech-status') await storeWebspeechStatus(m.status);
    return;
  }
  const s = session;
  switch (m.event) {
    case 'engine': s.engine = m.engine; await toTab(s.tabId, s.frameId, { type: 'engine', engine: m.engine, sid: s.sid }); break;
    case 'listening':
      s.state = 'listening'; s.engine = m.engine; await saveSession();
      await setBadge('listening', s.lang);
      await toTab(s.tabId, s.frameId, { type: 'state', state: 'listening', engine: m.engine, lang: s.lang, sid: s.sid });
      break;
    case 'status': await toTab(s.tabId, s.frameId, { type: 'status', text: m.text, sid: s.sid }); break;
    case 'level': toTab(s.tabId, s.frameId, { type: 'level', level: m.level, speaking: m.speaking, sid: s.sid }); break;
    case 'interim': toTab(s.tabId, s.frameId, { type: 'interim', text: m.text, sid: s.sid }); break;
    case 'final': {
      const r = await toTab(s.tabId, s.frameId, { type: 'final', text: m.text, engine: m.engine, sid: s.sid });
      if (r && r.actions && r.actions.includes('stop')) await stopSession('voice');
      break;
    }
    case 'fallback':
      await toTab(s.tabId, s.frameId, { type: 'fallback', from: m.from, to: m.to, message: m.message, sid: s.sid });
      break;
    case 'webspeech-status': await storeWebspeechStatus(m.status); break;
    case 'auto-stop': await toTab(s.tabId, s.frameId, { type: 'toast', text: 'Запись остановлена: тишина', sid: s.sid }); break;
    case 'error': await failSession(m.code, m.message); break;
    case 'stopped': await finishSession(m.reason); break;
  }
}
async function storeWebspeechStatus(status) {
  await chrome.storage.local.set({ webspeechStatus: status, webspeechCheckedAt: Date.now() });
}

/* ---------- сообщения ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to !== 'bg') return;
  const tabId = sender.tab ? sender.tab.id : undefined;
  const isExtPage = sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
  (async () => {
    switch (msg.type) {
      case 'engine-event': await onEngineEvent(msg); return { ok: true };
      case 'focus':
        if (tabId !== undefined) {
          focusByTab.set(tabId, sender.frameId || 0);
          await loadSession();
          if (session && session.tabId === tabId && session.frameId !== (sender.frameId || 0)) {
            session.frameId = sender.frameId || 0;
            await toTab(tabId, session.frameId, { type: 'state', state: session.state === 'listening' ? 'listening' : 'starting', engine: session.engine, lang: session.lang, sid: session.sid });
          }
          saveSession();
        }
        return { ok: true };
      case 'toggle': await toggle(tabId, sender.frameId || 0, { extPage: isExtPage && !!sender.tab, mock: msg.mock }); return { ok: true };
      case 'stop': await stopSession(msg.reason || 'user'); return { ok: true };
      case 'get-state': await loadSession(); return { session };
      case 'test-start': // используется автотестами: запуск с тестовым движком
        await startSession(msg.tabId ?? tabId, msg.frameId, { mock: msg.mock, extPage: msg.extPage });
        return { ok: true };
      case 'set-lang': await chrome.storage.local.set({ lang: msg.lang }); await updateMenus(); return { ok: true };
      default: return { ok: false };
    }
  })().then(sendResponse, e => sendResponse({ ok: false, error: String(e) }));
  return true;
});

/* ---------- команды и кнопка ---------- */
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-dictation') await toggle(tab ? tab.id : undefined, undefined);
  if (command === 'switch-language') await switchLang(tab);
});
chrome.action.onClicked.addListener(async (tab) => { await toggle(tab.id, undefined); });

async function switchLang(tab) {
  const s = await getSettings();
  const lang = s.lang === 'ru-RU' ? 'en-US' : 'ru-RU';
  await chrome.storage.local.set({ lang });
  await updateMenus();
  const t = tab ? tab.id : (session && session.tabId);
  if (t !== undefined) await toTab(t, focusByTab.get(t) ?? 0, { type: 'toast', text: 'Язык диктовки: ' + (lang === 'ru-RU' ? 'русский' : 'English') });
  if (session && session.state === 'listening') { const { tabId, frameId } = session; await stopSession('lang'); setTimeout(() => startSession(tabId, frameId), 1200); }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => { await loadSession(); if (session && session.tabId !== tabId) await stopSession('tab-switch'); });
chrome.tabs.onRemoved.addListener(async (tabId) => { focusByTab.delete(tabId); await loadSession(); if (session && session.tabId === tabId) await stopSession('tab-closed'); });

/* ---------- контекстное меню значка ---------- */
async function updateMenus() {
  const s = await getSettings();
  try {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({ id: 'lang-ru', title: 'Язык: русский', type: 'radio', checked: s.lang === 'ru-RU', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'lang-en', title: 'Язык: English', type: 'radio', checked: s.lang === 'en-US', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'options', title: 'Настройки голосового ввода', contexts: ['action'] });
  } catch {}
}
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'lang-ru') await chrome.storage.local.set({ lang: 'ru-RU' });
  if (info.menuItemId === 'lang-en') await chrome.storage.local.set({ lang: 'en-US' });
  if (info.menuItemId === 'options') chrome.runtime.openOptionsPage();
});
chrome.runtime.onInstalled.addListener(async (d) => {
  await updateMenus();
  await setBadge('idle');
  if (d.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#welcome') });
});
chrome.runtime.onStartup.addListener(() => { updateMenus(); setBadge('idle'); });
