/* Offscreen-документ: микрофон, движки распознавания, детектор тишины.
   Работает в источнике расширения, поэтому разрешение на микрофон выдаётся один раз (в настройках). */
'use strict';

let active = null;          // текущая сессия
const voskModels = new Map(); // lang -> Promise<Vosk.Model>

function emit(event, data) {
  const sid = data && data.sid !== undefined ? data.sid : (active ? active.sid : 0);
  chrome.runtime.sendMessage(Object.assign({ to: 'bg', type: 'engine-event', event, sid }, data || {})).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.to !== 'offscreen') return;
  if (msg.type === 'start') { start(msg); sendResponse({ ok: true }); return; }
  if (msg.type === 'stop') { stop(msg.reason || 'user'); sendResponse({ ok: true }); return; }
  if (msg.type === 'ping') { sendResponse({ ok: true, active: !!active }); return; }
  if (msg.type === 'mic-state') { micPermission().then(sendResponse); return true; }
});

async function micPermission() {
  try { return (await navigator.permissions.query({ name: 'microphone' })).state; } catch { return 'unknown'; }
}

/* ---------------- звук-подсказка ---------------- */
let beepCtx = null;
function beep(up) {
  try {
    beepCtx = beepCtx || new AudioContext();
    const o = beepCtx.createOscillator(), g = beepCtx.createGain();
    const t = beepCtx.currentTime;
    o.frequency.setValueAtTime(up ? 660 : 520, t);
    o.frequency.linearRampToValueAtTime(up ? 880 : 390, t + 0.12);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(beepCtx.destination); o.start(t); o.stop(t + 0.18);
  } catch {}
}

/* ---------------- микрофон + уровень + тишина ---------------- */
async function openMic(s) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  });
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  source.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  const m = { stream, ctx, source, proc, floor: null, lastLevelSent: 0, sink: null };
  proc.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    m.floor = m.floor === null ? rms : (rms < m.floor ? rms : m.floor + (rms - m.floor) * 0.02);
    const speaking = rms > Math.max(0.012, m.floor * 2.5);
    if (active && speaking) active.lastActivity = Date.now();
    const now = Date.now();
    if (now - m.lastLevelSent > 150) { m.lastLevelSent = now; emit('level', { level: Math.min(1, rms * 6), speaking }); }
    if (m.sink) { try { m.sink(new Float32Array(data), ctx.sampleRate, rms); } catch (err) { console.error(err); } }
  };
  return m;
}
function closeMic(m) {
  if (!m) return;
  try { m.proc.onaudioprocess = null; m.proc.disconnect(); m.source.disconnect(); } catch {}
  try { m.stream.getTracks().forEach(t => t.stop()); } catch {}
  try { m.ctx.close(); } catch {}
}

/* ---------------- сессия ---------------- */
async function start(msg) {
  if (active) await stop('restart', true);
  const s = msg.settings || {};
  const sess = active = {
    sid: msg.sid, order: msg.order && msg.order.length ? msg.order : ['google'], idx: 0,
    lang: msg.lang || 'ru-RU', settings: s, mock: msg.mock || null,
    gotResult: false, lastActivity: Date.now(), engine: null, mic: null, stopped: false, silenceTimer: null
  };
  const needsMic = sess.order.some(e => e !== 'mock');
  if (needsMic) {
    try { sess.mic = await openMic(s); }
    catch (e) {
      const name = e && e.name;
      const code = (name === 'NotAllowedError' || name === 'SecurityError') ? 'mic-denied' : (name === 'NotFoundError' || name === 'OverconstrainedError') ? 'no-mic' : 'mic-error';
      emit('error', { sid: sess.sid, code, message: String(e && e.message || e) });
      active = null; return;
    }
    if (active !== sess) { closeMic(sess.mic); return; }
  }
  sess.silenceTimer = setInterval(() => {
    const sec = Number(s.silenceStopSec) || 0;
    if (active === sess && sec > 0 && Date.now() - sess.lastActivity > sec * 1000) {
      emit('auto-stop', { sid: sess.sid, reason: 'silence' });
      stop('silence');
    }
  }, 500);
  runEngine(sess);
}

function hooks(sess, kind) {
  const alive = () => active === sess || (sess.stopped && sess.draining);
  return {
    interim(text) { if (alive()) { if (text) sess.lastActivity = Date.now(); emit('interim', { sid: sess.sid, text, engine: kind }); } },
    final(text) {
      if (!alive()) return;
      text = String(text || '').trim();
      if (!text) return;
      sess.gotResult = true; sess.lastActivity = Date.now();
      emit('final', { sid: sess.sid, text, engine: kind });
      if (kind === 'google' && sess.settings.webspeechStatus !== 'ok') { sess.settings.webspeechStatus = 'ok'; emit('webspeech-status', { sid: sess.sid, status: 'ok' }); }
    },
    status(text) { if (alive()) emit('status', { sid: sess.sid, text, engine: kind }); },
    ready() { if (active === sess) emit('listening', { sid: sess.sid, engine: kind, lang: sess.lang }); if (sess.settings.sounds) beep(true); },
    fatal(code, message, fallbackable) {
      if (active !== sess || sess.engineKind !== kind) return;
      if (kind === 'google' && code === 'webspeech-network' && navigator.onLine) emit('webspeech-status', { sid: sess.sid, status: 'unavailable' });
      if (fallbackable && !sess.gotResult && sess.idx + 1 < sess.order.length) {
        try { sess.engine && sess.engine.stop(); } catch {}
        sess.idx++;
        emit('fallback', { sid: sess.sid, from: kind, to: sess.order[sess.idx], code, message });
        runEngine(sess);
        return;
      }
      emit('error', { sid: sess.sid, code, message, engine: kind });
      stop('error');
    }
  };
}

function runEngine(sess) {
  const kind = sess.order[sess.idx];
  sess.engineKind = kind;
  if (sess.mic) sess.mic.sink = null;
  const h = hooks(sess, kind);
  emit('engine', { sid: sess.sid, engine: kind });
  try {
    if (kind === 'google') sess.engine = webSpeechEngine(h, sess, false);
    else if (kind === 'google-local') sess.engine = webSpeechEngine(h, sess, true);
    else if (kind === 'google-cloud') sess.engine = cloudEngine(h, sess);
    else if (kind === 'vosk') sess.engine = voskEngine(h, sess);
    else if (kind === 'mock') sess.engine = mockEngine(h, sess);
    else h.fatal('unknown-engine', 'Неизвестный движок: ' + kind, true);
  } catch (e) {
    h.fatal('engine-crash', String(e && e.message || e), true);
  }
}

async function stop(reason, silent) {
  const sess = active;
  if (!sess) return;
  sess.stopped = true; sess.draining = true;
  active = null;
  clearInterval(sess.silenceTimer);
  let p = null;
  try { p = sess.engine && sess.engine.stop(); } catch {}
  closeMic(sess.mic);
  if (!silent && sess.settings.sounds) beep(false);
  if (p && p.then) { await Promise.race([p.catch(() => {}), new Promise(r => setTimeout(r, 9000))]); }
  sess.draining = false;
  if (!silent) emit('stopped', { sid: sess.sid, reason });
}

/* ---------------- Google Web Speech (облако Chrome или на устройстве) ---------------- */
function webSpeechEngine(h, sess, local) {
  const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
  let running = true, r = null, startedAt = 0, restarts = 0;
  if (!SR) { setTimeout(() => h.fatal('webspeech-missing', 'В этом браузере нет Web Speech API', true)); return { stop() {} }; }
  const begin = async () => {
    if (local) {
      if (typeof SR.available !== 'function') return h.fatal('local-unsupported', 'Браузер не поддерживает распознавание Google на устройстве', true);
      let st = 'unavailable';
      try { st = await SR.available({ langs: [sess.lang], processLocally: true }); } catch {}
      if (st !== 'available') return h.fatal('local-not-installed', 'Языковой пакет Google на устройстве не установлен (Настройки → «Установить пакет»)', true);
    }
    if (!running) return;
    r = new SR();
    r.lang = sess.lang; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    if (local) { try { r.processLocally = true; } catch {} }
    let first = true;
    // Если ещё неизвестно, работает ли сервис Google в этом браузере (Vivaldi отвечает ошибкой network
    // через долю секунды), не объявляем «Говорите…», пока не убедимся, что ошибки нет.
    const confirmMs = (!local && sess.settings.webspeechStatus !== 'ok') ? 1600 : 0;
    const announce = () => { if (first && running) { first = false; h.ready(); } };
    r.onstart = () => { startedAt = Date.now(); if (!confirmMs) announce(); };
    r.onaudiostart = () => { if (confirmMs) setTimeout(announce, confirmMs); };
    r.onresult = (e) => {
      announce();
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) h.final(res[0].transcript); else interim += res[0].transcript;
      }
      h.interim(interim.trim());
    };
    r.onerror = (e) => {
      const c = e.error;
      if (c === 'no-speech' || c === 'aborted') return;
      running = false;
      if (c === 'network') h.fatal('webspeech-network', 'Сервис распознавания Google недоступен в этом браузере (ошибка network)', true);
      else if (c === 'not-allowed') h.fatal('mic-denied', 'Нет доступа к микрофону', false);
      else if (c === 'service-not-allowed') h.fatal('webspeech-blocked', 'Браузер запретил сервис распознавания Google', true);
      else if (c === 'audio-capture') h.fatal('no-mic', 'Микрофон не найден', false);
      else if (c === 'language-not-supported') h.fatal('lang-unsupported', 'Язык не поддерживается этим движком', true);
      else h.fatal('webspeech-' + c, 'Ошибка распознавания: ' + c, true);
    };
    r.onend = () => {
      if (!running) return;
      // Chrome сам завершает сессию примерно раз в минуту — перезапускаем
      restarts++;
      const quick = Date.now() - startedAt < 1000;
      if (quick && restarts > 5 && !sess.gotResult) { running = false; return h.fatal('webspeech-loop', 'Google Web Speech сразу завершает сессию', true); }
      setTimeout(() => { if (running) { try { r.start(); } catch {} } }, quick ? 300 : 50);
    };
    try { r.start(); } catch (e) { running = false; h.fatal('webspeech-start', String(e.message || e), true); }
  };
  begin();
  return { stop() { running = false; if (r) { try { r.stop(); } catch {} } return new Promise(res => setTimeout(res, 600)); } };
}

/* ---------------- Google Cloud Speech-to-Text (свой API-ключ) ---------------- */
function cloudEngine(h, sess) {
  const key = (sess.settings.cloudApiKey || '').trim();
  if (!key) { setTimeout(() => h.fatal('cloud-no-key', 'Не указан API-ключ Google Cloud (Настройки)', true)); return { stop() {} }; }
  if (!sess.mic) { setTimeout(() => h.fatal('no-mic', 'Нет микрофона', false)); return { stop() {} }; }
  const RATE = 16000, FRAME = 320; // 20 мс
  let resampleAcc = [], carry = 0, frameBuf = new Int16Array(FRAME), frameLen = 0, frameSq = 0;
  let floor = null, inSpeech = false, speechRun = 0, silenceRun = 0;
  let pre = [], seg = [];
  let queue = Promise.resolve(), pending = 0, punct = sess.settings.cloudPunctuation !== false, dead = false;
  const lang = sess.lang;

  function onFrame(frame, rms) {
    floor = floor === null ? rms : (rms < floor ? rms : floor + (rms - floor) * 0.01);
    const loud = rms > Math.max(0.01, floor * 3);
    if (!inSpeech) {
      pre.push(frame); if (pre.length > 15) pre.shift();
      speechRun = loud ? speechRun + 1 : 0;
      if (speechRun >= 3) { inSpeech = true; seg = pre.slice(); pre = []; silenceRun = 0; h.interim('…'); }
    } else {
      seg.push(frame);
      silenceRun = loud ? 0 : silenceRun + 1;
      if (silenceRun >= 40 || seg.length >= 1500) { flush(); }
    }
  }
  function flush() {
    const frames = seg; seg = []; inSpeech = false; speechRun = 0; silenceRun = 0;
    if (frames.length < 15) return; // < 0.3 с
    const pcm = new Int16Array(frames.length * FRAME);
    frames.forEach((f, i) => pcm.set(f, i * FRAME));
    send(pcm);
  }
  function b64(int16) {
    const bytes = new Uint8Array(int16.buffer); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function send(pcm) {
    pending++;
    h.status('Распознаю…');
    const body = { config: { encoding: 'LINEAR16', sampleRateHertz: RATE, languageCode: lang, maxAlternatives: 1 }, audio: { content: b64(pcm) } };
    if (punct) body.config.enableAutomaticPunctuation = true;
    queue = queue.then(async () => {
      if (dead) return;
      try {
        let res = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + encodeURIComponent(key), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store'
        });
        let json = await res.json().catch(() => ({}));
        if (!res.ok && punct && res.status === 400 && /punctuation/i.test(JSON.stringify(json))) {
          punct = false; delete body.config.enableAutomaticPunctuation;
          res = await fetch('https://speech.googleapis.com/v1/speech:recognize?key=' + encodeURIComponent(key), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' });
          json = await res.json().catch(() => ({}));
        }
        if (!res.ok) {
          const m = (json.error && json.error.message) || ('HTTP ' + res.status);
          dead = true;
          const code = res.status === 400 && /API key/i.test(m) ? 'cloud-bad-key' : (res.status === 403 ? 'cloud-forbidden' : 'cloud-http');
          h.fatal(code, 'Google Cloud: ' + m, true);
          return;
        }
        const text = (json.results || []).map(r => r.alternatives && r.alternatives[0] ? r.alternatives[0].transcript : '').join(' ').trim();
        if (text) h.final(text);
      } catch (e) {
        h.fatal('cloud-network', 'Google Cloud: нет связи (' + (e.message || e) + ')', true);
        dead = true;
      } finally {
        pending--; if (!pending) h.interim('');
      }
    });
  }
  sess.mic.sink = (data, sr) => {
    // понижаем частоту до 16 кГц (усреднение) и режем на кадры по 20 мс
    const ratio = sr / RATE;
    let pos = carry;
    while (pos + ratio <= data.length) {
      const a = Math.floor(pos), b = Math.min(data.length, Math.floor(pos + ratio));
      let acc = 0; for (let i = a; i < b; i++) acc += data[i];
      const v = acc / Math.max(1, b - a);
      const s = Math.max(-1, Math.min(1, v));
      frameBuf[frameLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      frameSq += s * s;
      if (frameLen === FRAME) {
        onFrame(frameBuf, Math.sqrt(frameSq / FRAME));
        frameBuf = new Int16Array(FRAME); frameLen = 0; frameSq = 0;
      }
      pos += ratio;
    }
    carry = pos - data.length;
  };
  setTimeout(() => h.ready());
  return {
    stop() { if (sess.mic) sess.mic.sink = null; if (inSpeech) flush(); return queue; }
  };
}

/* ---------------- Vosk (офлайн) ---------------- */
async function getVoskModel(lang) {
  if (voskModels.has(lang)) return voskModels.get(lang);
  const p = (async () => {
    const rec = await GVModels.get(lang);
    if (!rec || !rec.blob) { const e = new Error('Офлайн-модель для ' + lang + ' не установлена (Настройки → «Офлайн-распознавание»)'); e.code = 'vosk-no-model'; throw e; }
    const url = URL.createObjectURL(rec.blob) + '#key=' + rec.name;
    try { return await Vosk.createModel(url, -1); } finally { setTimeout(() => URL.revokeObjectURL(url.split('#')[0]), 60000); }
  })();
  voskModels.set(lang, p);
  p.catch(() => voskModels.delete(lang));
  return p;
}
function voskEngine(h, sess) {
  let rec = null, stopped = false;
  if (!sess.mic) { setTimeout(() => h.fatal('no-mic', 'Нет микрофона', false)); return { stop() {} }; }
  const t0 = Date.now();
  const slow = setTimeout(() => h.status('Загружаю офлайн-модель…'), 400);
  getVoskModel(sess.lang).then((model) => {
    clearTimeout(slow);
    if (stopped) return;
    rec = new model.KaldiRecognizer(sess.mic.ctx.sampleRate);
    rec.on('result', (m) => { const t = m && m.result && m.result.text; if (t) h.final(t); });
    rec.on('partialresult', (m) => { const t = m && m.result && m.result.partial; h.interim(t || ''); });
    sess.mic.sink = (data, sr) => { rec.acceptWaveformFloat(data, sr); };
    sess.lastActivity = Date.now();
    h.ready();
    console.log('vosk ready in', Date.now() - t0, 'ms');
  }).catch((e) => { clearTimeout(slow); h.fatal(e.code || 'vosk-error', String(e.message || e), true); });
  return {
    stop() {
      stopped = true;
      if (sess.mic) sess.mic.sink = null;
      if (!rec) return;
      const r = rec;
      try { r.retrieveFinalResult(); } catch {}
      return new Promise(res => setTimeout(() => { try { r.remove(); } catch {} res(); }, 700));
    }
  };
}

/* ---------------- тестовый движок (используется автотестами) ---------------- */
function mockEngine(h, sess) {
  const script = (sess.mock && sess.mock.length) ? sess.mock : [{ final: 'тест' }];
  let stopped = false;
  (async () => {
    h.ready();
    for (const step of script) {
      await new Promise(r => setTimeout(r, step.delay || 120));
      if (stopped) return;
      if (step.interim !== undefined) h.interim(step.interim);
      if (step.final !== undefined) h.final(step.final);
      if (step.fatal) h.fatal(step.fatal, step.message || step.fatal, step.fallbackable !== false);
    }
  })();
  return { stop() { stopped = true; } };
}
