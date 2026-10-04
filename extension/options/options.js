'use strict';
const $ = (s) => document.querySelector(s);
const D = self.GV_DEFAULTS;
let S = {};

async function load() { S = Object.assign({}, D, await chrome.storage.local.get(null)); }
function save(patch) { Object.assign(S, patch); return chrome.storage.local.set(patch); }
function setSt(el, text, cls) { el.textContent = text; el.className = 'st ' + (cls || ''); }

async function init() {
  await load();
  $('#ver').textContent = chrome.runtime.getManifest().version;
  if (location.hash === '#welcome') $('#welcome').hidden = false;
  if (location.hash === '#mic') { $('#sec-mic').classList.add('hl'); $('#sec-mic').scrollIntoView(); }

  // флажки
  for (const id of ['showMicButton', 'voiceCommands', 'autoCapitalize', 'lowercaseMidSentence', 'interimPreview', 'escStops', 'sounds', 'cloudPunctuation']) {
    const el = $('#' + id); el.checked = !!S[id];
    el.addEventListener('change', () => save({ [id]: el.checked }));
  }
  const sil = $('#silenceStopSec'); sil.value = String(S.silenceStopSec);
  sil.addEventListener('change', () => save({ silenceStopSec: Number(sil.value) }));
  for (const r of document.querySelectorAll('input[name=engine]')) {
    r.checked = r.value === S.engine;
    r.addEventListener('change', () => r.checked && save({ engine: r.value }));
  }
  for (const r of document.querySelectorAll('input[name=lang]')) {
    r.checked = r.value === S.lang;
    r.addEventListener('change', () => r.checked && save({ lang: r.value }));
  }
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.lang) for (const r of document.querySelectorAll('input[name=lang]')) r.checked = r.value === ch.lang.newValue;
    if (ch.webspeechStatus) showWs();
  });

  // ключ Google Cloud
  const key = $('#cloudApiKey'); key.value = S.cloudApiKey || '';
  key.addEventListener('change', () => save({ cloudApiKey: key.value.trim() }));
  $('#cloudShow').addEventListener('click', () => { key.type = key.type === 'password' ? 'text' : 'password'; });
  $('#cloudTest').addEventListener('click', testCloud);

  initMic();
  showWs();
  $('#wsTest').addEventListener('click', (e) => { e.preventDefault(); testWebSpeech(); });
  $('#localInstall').addEventListener('click', (e) => { e.preventDefault(); installLocal(); });
  showLocal();
  renderVosk();
  initHotkey();
  browserNote();
}

/* ---------- микрофон ---------- */
async function initMic() {
  const el = $('#micState');
  const show = (st) => {
    el.textContent = st === 'granted' ? 'разрешён ✓' : st === 'denied' ? 'запрещён — разрешите в настройках сайта (значок слева в адресной строке)' : 'не разрешён';
    el.style.color = st === 'granted' ? '#16a34a' : '#dc2626';
    $('#micGrant').textContent = st === 'granted' ? 'Проверить микрофон' : 'Разрешить микрофон';
  };
  try {
    const p = await navigator.permissions.query({ name: 'microphone' });
    show(p.state); p.onchange = () => show(p.state);
  } catch { show('prompt'); }
  $('#micGrant').addEventListener('click', async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const label = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].label : '';
      stream.getTracks().forEach(t => t.stop());
      show('granted');
      if (label) el.textContent += ' (' + label + ')';
      $('#sec-mic').classList.remove('hl');
      // сразу проверяем, доступен ли в этом браузере бесплатный сервис Google (в Vivaldi — нет)
      const { webspeechStatus } = await chrome.storage.local.get('webspeechStatus');
      if (!webspeechStatus || webspeechStatus === 'unknown') testWebSpeech();
    } catch (e) {
      el.textContent = 'ошибка: ' + (e.name === 'NotFoundError' ? 'микрофон не найден' : e.name === 'NotAllowedError' ? 'доступ запрещён' : e.message);
      el.style.color = '#dc2626';
    }
  });
}

/* ---------- Google Web Speech ---------- */
function showWs() {
  chrome.storage.local.get(['webspeechStatus', 'webspeechCheckedAt']).then(({ webspeechStatus, webspeechCheckedAt }) => {
    const el = $('#wsState');
    const when = webspeechCheckedAt ? ' (' + new Date(webspeechCheckedAt).toLocaleString('ru-RU') + ')' : '';
    if (webspeechStatus === 'ok') setSt(el, 'работает в этом браузере ✓' + when, 'ok');
    else if (webspeechStatus === 'unavailable') setSt(el, 'недоступен в этом браузере' + when, 'bad');
    else setSt(el, 'ещё не проверялся', '');
  });
}
function testWebSpeech() {
  const el = $('#wsState');
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
  if (!SR) { setSt(el, 'Web Speech API отсутствует', 'bad'); return; }
  setSt(el, 'проверяю… скажите что-нибудь', 'warn');
  const r = new SR(); r.lang = S.lang; r.interimResults = true; r.continuous = false;
  let done = false, started = false;
  const finish = async (status, text, cls) => {
    if (done) return; done = true;
    try { r.abort(); } catch {}
    if (status) await chrome.storage.local.set({ webspeechStatus: status, webspeechCheckedAt: Date.now() });
    setSt(el, text, cls);
  };
  r.onstart = () => { started = true; };
  r.onresult = (e) => finish('ok', 'работает ✓ «' + e.results[0][0].transcript + '»', 'ok');
  r.onerror = (e) => {
    if (e.error === 'network') finish('unavailable', 'недоступен: ошибка network (браузер не подключён к сервису Google)', 'bad');
    else if (e.error === 'not-allowed') finish(null, 'нет доступа к микрофону — сначала разрешите его выше', 'bad');
    else if (e.error === 'no-speech') finish('ok', 'сервис отвечает ✓ (речь не услышана)', 'ok');
    else finish(null, 'ошибка: ' + e.error, 'bad');
  };
  r.onend = () => { if (!done) finish(started ? 'ok' : null, started ? 'сервис отвечает ✓' : 'не удалось запустить', started ? 'ok' : 'bad'); };
  try { r.start(); } catch (e) { finish(null, 'ошибка: ' + e.message, 'bad'); }
  setTimeout(() => { if (!done) { try { r.stop(); } catch {} } }, 6000);
}

/* ---------- Google на устройстве ---------- */
async function showLocal() {
  const el = $('#localState');
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
  if (!SR || typeof SR.available !== 'function') { setSt(el, 'браузер не поддерживает', 'bad'); $('#localInstall').disabled = true; return; }
  try {
    const ru = await SR.available({ langs: [S.lang], processLocally: true });
    const en = S.lang === 'en-US' ? ru : await SR.available({ langs: ['en-US'], processLocally: true });
    const t = { available: 'установлен', downloadable: 'можно скачать', downloading: 'скачивается…', unavailable: 'недоступен' };
    setSt(el, S.lang + ': ' + (t[ru] || ru) + (S.lang !== 'en-US' ? ', en-US: ' + (t[en] || en) : ''), ru === 'available' ? 'ok' : 'warn');
  } catch (e) { setSt(el, 'ошибка: ' + e.message, 'bad'); }
}
async function installLocal() {
  const el = $('#localState');
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
  setSt(el, 'скачиваю языковые пакеты Google…', 'warn');
  try {
    // пакет en-US нужен всегда: служба распознавания Chromium запускается только при наличии языка «Живых субтитров»
    const a = await SR.install({ langs: [S.lang], processLocally: true });
    const b = S.lang === 'en-US' ? a : await SR.install({ langs: ['en-US'], processLocally: true });
    setSt(el, a && b ? 'установлено ✓ (может понадобиться перезапуск браузера)' : 'не удалось установить', a && b ? 'ok' : 'bad');
  } catch (e) { setSt(el, 'ошибка: ' + e.message, 'bad'); }
  setTimeout(showLocal, 1500);
}

/* ---------- Google Cloud ---------- */
async function testCloud() {
  const el = $('#cloudState');
  const key = $('#cloudApiKey').value.trim();
  await save({ cloudApiKey: key });
  if (!key) { setSt(el, 'введите ключ', 'bad'); return; }
  setSt(el, 'проверяю…', 'warn');
  const silence = new Int16Array(8000); // 0,5 с тишины, 16 кГц
  const bytes = new Uint8Array(silence.buffer); let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  try {
    const res = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify({ config: { encoding: 'LINEAR16', sampleRateHertz: 16000, languageCode: S.lang }, audio: { content: btoa(bin) } })
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) setSt(el, 'ключ работает ✓', 'ok');
    else setSt(el, 'ошибка ' + res.status + ': ' + ((j.error && j.error.message) || ''), 'bad');
  } catch (e) { setSt(el, 'нет связи с Google: ' + e.message, 'bad'); }
}

/* ---------- офлайн-модели Vosk ---------- */
async function renderVosk() {
  const box = $('#voskBlock');
  box.textContent = '';
  for (const [lang, m] of Object.entries(GVModels.MODELS)) {
    const info = await GVModels.info(lang);
    const row = document.createElement('div'); row.className = 'model'; row.dataset.lang = lang;
    const title = document.createElement('b'); title.textContent = lang === 'ru-RU' ? 'Русский' : 'English';
    const st = document.createElement('span'); st.className = 'st ' + (info.installed ? 'ok' : '');
    st.textContent = info.installed ? 'установлена ✓ (' + (info.size / 1048576).toFixed(0) + ' МБ)' : 'не установлена';
    row.append(title, st);
    if (!info.installed) {
      const dl = document.createElement('button'); dl.className = 'small primary'; dl.textContent = 'Скачать (' + m.sizeMb + ' МБ)';
      dl.dataset.action = 'download';
      dl.addEventListener('click', () => downloadModel(lang, row));
      const file = document.createElement('input'); file.type = 'file'; file.accept = '.zip,.tar.gz,.tgz'; file.hidden = true;
      const up = document.createElement('button'); up.className = 'small'; up.textContent = 'Из файла…';
      up.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files[0]; if (!f) return;
        await GVModels.put(lang, { name: m.name + '-file-' + f.size, blob: f, date: Date.now() });
        renderVosk();
      });
      row.append(dl, up, file);
    } else {
      const del = document.createElement('button'); del.className = 'small'; del.textContent = 'Удалить';
      del.addEventListener('click', async () => { await GVModels.del(lang); renderVosk(); });
      row.append(del);
    }
    box.append(row);
  }
  const note = document.createElement('p'); note.className = 'hint';
  note.textContent = 'Модели скачиваются с alphacephei.com (авторы Vosk) и хранятся внутри браузера. Первый запуск после скачивания — 10–20 секунд (распаковка), дальше 2–4 секунды.';
  box.append(note);
}
async function downloadModel(lang, row) {
  const m = GVModels.MODELS[lang];
  const btn = row.querySelector('[data-action=download]'); btn.disabled = true;
  const prog = document.createElement('progress'); prog.max = 1; prog.value = 0; row.append(prog);
  const st = row.querySelector('.st');
  try {
    const res = await fetch(m.url, { credentials: 'omit' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = Number(res.headers.get('content-length')) || m.sizeMb * 1048576;
    const reader = res.body.getReader(); const chunks = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      prog.value = got / total; st.textContent = 'скачано ' + (got / 1048576).toFixed(1) + ' из ' + (total / 1048576).toFixed(0) + ' МБ';
    }
    await GVModels.put(lang, { name: m.name, blob: new Blob(chunks, { type: 'application/zip' }), date: Date.now() });
    renderVosk();
  } catch (e) {
    st.textContent = 'ошибка скачивания: ' + e.message; st.className = 'st bad'; btn.disabled = false; prog.remove();
  }
}

/* ---------- горячие клавиши ---------- */
function prettyHotkey(spec) { return String(spec || '').replace(/Key([A-Z])/, '$1').replace(/Digit(\d)/, '$1').replace('Space', 'Пробел').replace(/\+/g, ' + '); }
function initHotkey() {
  const btn = $('#hotkeyBtn');
  const show = () => { btn.textContent = prettyHotkey(S.pageHotkey) || 'не задано'; btn.classList.remove('rec'); };
  show();
  let rec = false;
  btn.addEventListener('click', () => { rec = true; btn.textContent = 'нажмите сочетание…'; btn.classList.add('rec'); });
  btn.addEventListener('keydown', (e) => {
    if (!rec) return;
    e.preventDefault(); e.stopPropagation();
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
    if (e.key === 'Escape') { rec = false; show(); return; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey) { btn.textContent = 'нужен Ctrl или Alt'; return; }
    const parts = []; if (e.ctrlKey) parts.push('Ctrl'); if (e.altKey) parts.push('Alt'); if (e.shiftKey) parts.push('Shift'); if (e.metaKey) parts.push('Meta');
    parts.push(e.code);
    rec = false; save({ pageHotkey: parts.join('+') }).then(show);
  }, true);
  $('#hotkeyReset').addEventListener('click', () => save({ pageHotkey: D.pageHotkey }).then(show));
  chrome.commands.getAll().then(cmds => {
    const c = cmds.find(x => x.name === 'toggle-dictation'), l = cmds.find(x => x.name === 'switch-language');
    $('#cmdKeys').textContent = 'диктовка — ' + (c && c.shortcut ? c.shortcut : 'не назначена') + '; язык — ' + (l && l.shortcut ? l.shortcut : 'не назначена');
  });
}

async function browserNote() {
  let brands = [];
  try { brands = (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand); } catch {}
  const isVivaldi = brands.some(b => /vivaldi/i.test(b)) || /Vivaldi/.test(navigator.userAgent);
  const st = S.webspeechStatus;
  $('#browserNote').textContent = isVivaldi || st === 'unavailable'
    ? 'Этот браузер не подключён к бесплатному сервису распознавания Google (так в Vivaldi). Используйте «Авто» с офлайн-моделью и/или ключом Google Cloud.'
    : st === 'ok' ? 'Google Web Speech в этом браузере работает — достаточно режима «Авто».'
      : 'В Google Chrome достаточно режима «Авто». В Vivaldi установите офлайн-модель или укажите ключ Google Cloud.';
}

init();
