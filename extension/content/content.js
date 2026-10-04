/* «Голосовой ввод»: работа с полями ввода на странице (input, textarea, contenteditable,
   iframe, shadow DOM), кнопка микрофона, индикатор записи и вставка текста. */
(() => {
  'use strict';
  if (window.__gvVoiceInput) return;
  window.__gvVoiceInput = true;

  const IS_EXT_PAGE = location.protocol === 'chrome-extension:';
  const T = self.GVText;
  const S = Object.assign({}, self.GV_DEFAULTS);
  const ENGINE_NAMES = self.GV_ENGINE_NAMES || {};
  try {
    chrome.storage.local.get(null).then(v => Object.assign(S, v)).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      for (const k in ch) S[k] = ch[k].newValue;
      if (!S.showMicButton) ui.hideMic();
    });
  } catch {}

  let myTabId = null;
  if (IS_EXT_PAGE && chrome.tabs && chrome.tabs.getCurrent) chrome.tabs.getCurrent(t => { myTabId = t ? t.id : null; });

  let lastEditable = null;
  let savedRange = null;
  let state = 'idle', sid = 0, lang = S.lang, engine = null;
  let lastInsert = null;
  let tabActive = false;      // идёт ли диктовка в этой вкладке (в любом фрейме)

  const send = (m) => { try { return chrome.runtime.sendMessage(Object.assign({ to: 'bg' }, m)).catch(() => null); } catch { return Promise.resolve(null); } };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  /* ---------------- поиск поля ---------------- */
  function deepActive() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  }
  const TEXT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', '']);
  function isInput(el) { return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'); }
  function editableOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return TEXT_TYPES.has(t) && !el.readOnly && !el.disabled ? el : null;   // пароли намеренно пропускаем
    }
    if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled ? el : null;
    if (el.isContentEditable) {
      let h = el;
      while (h.parentElement && h.parentElement.isContentEditable) h = h.parentElement;
      return h;
    }
    if (document.designMode === 'on' && (el === document.body || el === document.documentElement)) return document.body;
    return null;
  }
  function currentField(strict) {
    // strict: опрос всех фреймов — отвечает только тот, у которого реально фокус
    if (strict && !document.hasFocus()) return null;
    const a = editableOf(deepActive());
    if (a) return a;
    if (!strict && lastEditable && lastEditable.isConnected) return lastEditable;
    return null;
  }
  function getSel(node) {
    const root = node && node.getRootNode ? node.getRootNode() : document;
    if (root && root !== document && typeof root.getSelection === 'function') return root.getSelection();
    return window.getSelection();
  }

  function setEditable(t) {
    lastEditable = t;
    send({ type: 'focus' });
    if (S.showMicButton || state !== 'idle') ui.showMic(t);
    if (state !== 'idle') ui.showPill();
  }
  document.addEventListener('focusin', (e) => {
    const path = e.composedPath ? e.composedPath() : [e.target];
    if (path.some(n => n === ui.hostEl())) return;
    const t = editableOf(path[0]) || editableOf(deepActive());
    if (t) setEditable(t);
  }, true);
  document.addEventListener('focusout', () => {
    setTimeout(() => { if ((!editableOf(deepActive()) || !document.hasFocus()) && state === 'idle') ui.hideMic(); }, 150);
  }, true);
  window.addEventListener('blur', () => { setTimeout(() => { if (!document.hasFocus() && state === 'idle') ui.hideMic(); }, 150); });
  window.addEventListener('focus', () => { const t = editableOf(deepActive()); if (t && state === 'idle' && S.showMicButton) ui.showMic(t); });
  document.addEventListener('selectionchange', () => {
    const el = lastEditable;
    if (!el || isInput(el)) return;
    const sel = getSel(el);
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  }, true);
  const initial = () => { const t = editableOf(deepActive()); if (t) setEditable(t); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initial, { once: true }); else initial();

  function ensureFocus(el) {
    const a = deepActive();
    if (a === el || (el.contains && a && el.contains(a))) return;
    try { el.focus({ preventScroll: true }); } catch {}
    if (!isInput(el) && savedRange) {
      try { const sel = getSel(el); sel.removeAllRanges(); sel.addRange(savedRange); } catch {}
    }
  }

  /* ---------------- контекст вокруг курсора ---------------- */
  const BLOCK = /^(P|DIV|LI|H[1-6]|BLOCKQUOTE|PRE|TD|TH|DD|DT|SECTION|ARTICLE)$/;
  function closestBlock(node, host) {
    let n = node.nodeType === 1 ? node : node.parentElement;
    while (n && n !== host) { if (BLOCK.test(n.tagName)) return n; n = n.parentElement; }
    return host;
  }
  function getContext(el) {
    if (isInput(el)) {
      const v = el.value || '';
      let s = null, e = null;
      try { s = el.selectionStart; e = el.selectionEnd; } catch {}
      if (s === null || s === undefined) { s = e = v.length; }
      return { before: v.slice(Math.max(0, s - 200), s), after: v.slice(e, e + 50) };
    }
    const sel = getSel(el);
    if (!sel || !sel.rangeCount) return { before: '', after: '' };
    const r = sel.getRangeAt(0);
    if (!el.contains(r.startContainer)) return { before: '', after: '' };
    const block = closestBlock(r.startContainer, el);
    let before = '', after = '';
    try {
      const pre = document.createRange(); pre.selectNodeContents(block); pre.setEnd(r.startContainer, r.startOffset);
      before = pre.toString();
      if (!before && block !== el) {
        const all = document.createRange(); all.selectNodeContents(el); all.setEnd(r.startContainer, r.startOffset);
        if (all.toString().trim()) before = '\n';
      }
      const post = document.createRange(); post.selectNodeContents(block); post.setStart(r.endContainer, r.endOffset);
      after = post.toString();
    } catch {}
    return { before: before.slice(-200), after: after.slice(0, 50) };
  }

  /* ---------------- вставка ---------------- */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  }
  function inputInsert(el, text, del) {
    if (el.tagName === 'INPUT') text = text.replace(/\s*\n+\s*/g, ' ');
    const before = el.value;
    let selStart = null, selEnd = null;
    try { selStart = el.selectionStart; selEnd = el.selectionEnd; } catch {}
    let ok = false;
    try {
      for (let i = 0; i < del; i++) document.execCommand('delete', false);
      ok = text ? document.execCommand('insertText', false, text) : true;
    } catch { ok = false; }
    if (ok && (el.value !== before || !text)) return 'execCommand';
    // запасной путь: прямое присвоение через нативный сеттер + input-событие (React/Vue это видят)
    const cur = el.value;
    let s = selStart === null ? cur.length : selStart, e = selEnd === null ? cur.length : selEnd;
    if (cur === before && del) s = Math.max(0, s - del);
    const value = cur.slice(0, s) + text + cur.slice(e);
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text }));
    setNativeValue(el, value);
    try { el.setSelectionRange(s + text.length, s + text.length); } catch {}
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    return 'value-setter';
  }
  function isGoogleDocs() {
    try { return location.hostname === 'docs.google.com' && window.frameElement && window.frameElement.classList.contains('docs-texteventtarget-iframe'); } catch { return false; }
  }
  function pasteEvent(target, text) {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  }
  // Редакторы, которые ломаются от execCommand и правильно принимают вставку через событие paste
  function pasteFirstEditor(host) {
    return !!(host.closest && (host.closest('.public-DraftEditor-content, .DraftEditor-root') || host.querySelector('[data-contents="true"]')));
  }
  async function ceInsert(host, text, del) {
    if (isGoogleDocs()) { pasteEvent(deepActive() || host, text); return 'docs-paste'; }
    const snap = host.innerHTML;
    if (pasteFirstEditor(host)) {
      for (let i = 0; i < del; i++) document.execCommand('delete', false);
      const sel0 = getSel(host);
      const a0 = sel0 && sel0.anchorNode ? (sel0.anchorNode.nodeType === 1 ? sel0.anchorNode : sel0.anchorNode.parentElement) : host;
      pasteEvent(a0 || host, text);
      await sleep(60);
      if (host.innerHTML !== snap) return 'paste';
    }
    try {
      for (let i = 0; i < del; i++) document.execCommand('delete', false);
      for (const part of text.split(/(\n+)/)) {
        if (!part) continue;
        if (/^\n+$/.test(part)) document.execCommand(part.length >= 2 ? 'insertParagraph' : 'insertLineBreak', false);
        else document.execCommand('insertText', false, part);
      }
    } catch {}
    if (host.innerHTML !== snap) return 'execCommand';
    await sleep(60);                       // редакторы на React (Draft.js, Lexical) обновляют DOM асинхронно
    if (host.innerHTML !== snap) return 'execCommand';
    const sel = getSel(host);
    const anchor = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : host;
    pasteEvent(anchor || host, text);
    await sleep(60);
    if (host.innerHTML !== snap) return 'paste';
    // последний вариант: вставка через Range
    if (!sel || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const node = document.createTextNode(text);
    r.insertNode(node);
    r.setStartAfter(node); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
    host.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    return 'range';
  }
  async function insertText(el, text, del) {
    ensureFocus(el);
    const how = isInput(el) ? inputInsert(el, text, del || 0) : await ceInsert(el, text, del || 0);
    if (!isInput(el)) { const sel = getSel(el); if (sel && sel.rangeCount) savedRange = sel.getRangeAt(0).cloneRange(); }
    return how;
  }
  function undoLast() {
    const li = lastInsert;
    if (!li || !li.el.isConnected) return false;
    const el = li.el, n = li.text.length;
    ensureFocus(el);
    if (isInput(el)) {
      const c = el.selectionStart;
      if (c !== null && el.value.slice(c - n, c) === li.text) {
        el.setSelectionRange(c - n, c);
        if (!document.execCommand('delete', false)) {
          const v = el.value; setNativeValue(el, v.slice(0, c - n) + v.slice(c));
          el.setSelectionRange(c - n, c - n);
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
        }
      }
    } else {
      const sel = getSel(el);
      for (let i = 0; i < n; i++) sel.modify('extend', 'backward', 'character');
      document.execCommand('delete', false);
    }
    lastInsert = null;
    return true;
  }

  async function handleFinal(text) {
    const el = currentField(false);
    if (!el) { ui.toast('Нет активного поля. Распознано: «' + text + '»', 6000); return { inserted: false }; }
    const ctx = getContext(el);
    const r = T.process(text, { before: ctx.before, after: ctx.after, lang }, S);
    if (r.actions.includes('undo')) undoLast();
    let how = null;
    if (r.text) { how = await insertText(el, r.text, r.deleteBefore); lastInsert = { el, text: r.text }; }
    ui.interim('');
    return { inserted: !!r.text, how, text: r.text, actions: r.actions };
  }

  /* ---------------- горячие клавиши на странице ---------------- */
  function matchHotkey(e, spec) {
    if (!spec) return false;
    const parts = String(spec).split('+');
    const code = parts.pop();
    const mods = new Set(parts.map(p => p.toLowerCase()));
    return e.code === code && e.altKey === mods.has('alt') && e.ctrlKey === mods.has('ctrl') &&
      e.shiftKey === mods.has('shift') && e.metaKey === mods.has('meta');
  }
  window.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (matchHotkey(e, S.pageHotkey)) {
      e.preventDefault(); e.stopImmediatePropagation();
      const t = editableOf(deepActive()); if (t) lastEditable = t;
      send({ type: 'toggle' });
      return;
    }
    if (e.key === 'Escape' && S.escStops && (state === 'listening' || state === 'starting' || tabActive)) send({ type: 'stop', reason: 'esc' });
  }, true);

  /* ---------------- интерфейс (закрытый shadow DOM) ---------------- */
  const ui = (() => {
    let host = null, root = null, mic, pill, dot, label, interimEl, toastEl, toastTimer = null, anchor = null, raf = 0;
    const CSS = `
      :host{all:initial}
      *{box-sizing:border-box;font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}
      .mic{position:fixed;width:26px;height:26px;border-radius:50%;border:0;padding:0;margin:0;cursor:pointer;display:none;
        background:rgba(37,99,235,.92);box-shadow:0 1px 4px rgba(0,0,0,.35);align-items:center;justify-content:center;opacity:.78;transition:opacity .15s,transform .15s}
      .mic:hover{opacity:1;transform:scale(1.08)}
      .mic.rec{background:#dc2626;opacity:1;animation:pulse 1.2s infinite}
      .mic svg{width:15px;height:15px;fill:#fff;display:block}
      @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(220,38,38,.55)}70%{box-shadow:0 0 0 9px rgba(220,38,38,0)}100%{box-shadow:0 0 0 0 rgba(220,38,38,0)}}
      .pill{position:fixed;display:none;align-items:center;gap:8px;max-width:min(560px,92vw);min-height:30px;padding:5px 6px 5px 10px;border-radius:16px;
        background:#111827;color:#f9fafb;font-size:13px;line-height:18px;box-shadow:0 4px 16px rgba(0,0,0,.35)}
      .dot{flex:0 0 auto;width:10px;height:10px;border-radius:50%;background:#ef4444;transition:transform .12s}
      .pill.starting .dot{background:#f59e0b}
      .label{flex:0 0 auto;font-weight:600;white-space:nowrap}
      .interim{flex:1 1 auto;min-width:0;color:#cbd5e1;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left}
      .interim:empty{display:none}
      .chip{flex:0 0 auto;border:1px solid #4b5563;border-radius:9px;padding:0 6px;font-size:11px;color:#e5e7eb;cursor:pointer;background:transparent}
      .stop{flex:0 0 auto;width:22px;height:22px;border-radius:50%;border:0;background:#374151;color:#fff;cursor:pointer;font-size:13px;line-height:22px;padding:0}
      .stop:hover{background:#dc2626}
      .toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:none;max-width:min(520px,92vw);padding:9px 14px;border-radius:10px;
        background:#1f2937;color:#fff;font-size:13px;line-height:18px;box-shadow:0 4px 16px rgba(0,0,0,.35)}
    `;
    const MIC_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>';
    function ensure() {
      if (host && host.isConnected) return;
      host = document.createElement('gv-voice-input');
      host.setAttribute('data-gv', '1');
      host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${CSS}</style>
        <button class="mic" type="button" title="Голосовой ввод (${hotkeyLabel()})" aria-label="Голосовой ввод">${MIC_SVG}</button>
        <div class="pill" role="status" aria-live="polite"><span class="dot"></span><span class="label">Говорите…</span>
          <span class="interim"></span><button class="chip" type="button" title="Сменить язык (Alt+Shift+L)">RU</button>
          <button class="stop" type="button" title="Остановить (Esc)">✕</button></div>
        <div class="toast" role="alert"></div>`;
      mic = root.querySelector('.mic'); pill = root.querySelector('.pill'); dot = root.querySelector('.dot');
      label = root.querySelector('.label'); interimEl = root.querySelector('.interim'); toastEl = root.querySelector('.toast');
      // не отдаём фокус: иначе курсор уйдёт из поля
      root.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
      root.addEventListener('pointerdown', (e) => { e.stopPropagation(); }, true);
      mic.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (anchor) lastEditable = anchor; send({ type: 'toggle' }); });
      root.querySelector('.stop').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); send({ type: 'stop', reason: 'button' }); });
      root.querySelector('.chip').addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        send({ type: 'set-lang', lang: (lang === 'ru-RU' ? 'en-US' : 'ru-RU') }).then(() => { lang = lang === 'ru-RU' ? 'en-US' : 'ru-RU'; updateChip(); });
      });
      (document.documentElement || document.body).appendChild(host);
      window.addEventListener('scroll', schedule, true);
      window.addEventListener('resize', schedule, true);
    }
    function hotkeyLabel() { return String(S.pageHotkey || 'Alt+Shift+KeyV').replace(/Key([A-Z])/, '$1').replace(/Digit(\d)/, '$1'); }
    function updateChip() { if (root) root.querySelector('.chip').textContent = (lang || 'ru-RU').slice(0, 2).toUpperCase(); }
    function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); }
    function place() {
      if (!host || !anchor) return;
      const r = anchor.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && anchor.isConnected;
      if (mic.style.display !== 'none') {
        if (!visible || r.width < 60) mic.style.visibility = 'hidden';
        else {
          mic.style.visibility = 'visible';
          const top = r.height < 64 ? r.top + (r.height - 26) / 2 : r.bottom - 32;
          mic.style.left = Math.round(Math.min(innerWidth - 30, r.right - 32)) + 'px';
          mic.style.top = Math.round(Math.max(2, top)) + 'px';
        }
      }
      if (pill.style.display !== 'none') {
        if (!visible) { pill.style.left = '50%'; pill.style.transform = 'translateX(-50%)'; pill.style.top = 'auto'; pill.style.bottom = '72px'; }
        else {
          pill.style.transform = 'none'; pill.style.bottom = 'auto';
          const left = Math.max(6, Math.min(innerWidth - 300, r.left));
          const top = r.top > 44 ? r.top - 38 : Math.min(innerHeight - 40, r.bottom + 6);
          pill.style.left = Math.round(left) + 'px'; pill.style.top = Math.round(top) + 'px';
        }
      }
    }
    return {
      hostEl: () => host,
      showMic(el) {
        if (!el || (el === document.body && document.designMode !== 'on' && !el.isContentEditable)) return;
        if (!S.showMicButton && state === 'idle') return;
        ensure(); anchor = el; mic.style.display = 'flex'; mic.title = 'Голосовой ввод (' + hotkeyLabel() + ')'; place();
      },
      hideMic() { if (mic && state === 'idle') mic.style.display = 'none'; },
      showPill() { ensure(); if (lastEditable) anchor = lastEditable; pill.style.display = 'flex'; updateChip(); place(); },
      setState(st) {
        ensure();
        if (st === 'idle') {
          pill.style.display = 'none'; mic.classList.remove('rec'); interimEl.textContent = '';
          if (!S.showMicButton || !editableOf(deepActive())) mic.style.display = 'none';
          return;
        }
        if (lastEditable) anchor = lastEditable;
        if (S.showMicButton && anchor) { mic.style.display = 'flex'; }
        mic.classList.toggle('rec', st === 'listening');
        pill.classList.toggle('starting', st !== 'listening');
        const eng = engine && ENGINE_NAMES[engine] ? ' · ' + ENGINE_NAMES[engine] : '';
        label.textContent = st === 'listening' ? 'Говорите…' + eng : st === 'stopping' ? 'Завершаю…' : 'Подключаю микрофон…';
        this.showPill();
      },
      status(text) { ensure(); if (text) label.textContent = text; },
      level(v, speaking) { if (dot) dot.style.transform = 'scale(' + (1 + Math.min(1, v) * 0.9).toFixed(2) + ')'; },
      interim(text) { if (!interimEl) return; interimEl.textContent = S.interimPreview ? (text || '') : ''; },
      toast(text, ms) {
        ensure(); toastEl.textContent = text; toastEl.style.display = 'block';
        clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, ms || 3500);
      }
    };
  })();

  /* ---------------- сообщения от service worker ---------------- */
  const ERR = {
    'mic-denied': 'Нет доступа к микрофону. Открыл настройки — нажмите «Разрешить микрофон».',
    'no-mic': 'Микрофон не найден. Проверьте подключение и настройки Windows.',
    'vosk-no-model': 'Офлайн-модель не установлена. Откройте настройки расширения → «Офлайн-распознавание».'
  };
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.to !== 'cs') return;
    if (IS_EXT_PAGE && (msg.forTab === undefined || msg.forTab !== myTabId)) return;
    switch (msg.type) {
      case 'prepare': {
        const el = currentField(!!msg.strict);
        if (!el) { if (msg.strict) return; sendResponse({ hasField: false }); return; }
        lastEditable = el;
        if (msg.lang) lang = msg.lang;
        if (msg.strict) { send({ type: 'focus' }).then(() => sendResponse({ hasField: true })); return true; }
        sendResponse({ hasField: true });
        return;
      }
      case 'state':
        state = msg.state; sid = msg.sid || sid;
        if (msg.lang) lang = msg.lang;
        if (msg.engine) engine = msg.engine;
        ui.setState(state);
        sendResponse({ ok: true });
        return;
      case 'engine': engine = msg.engine; if (state !== 'idle') ui.setState(state); sendResponse({ ok: true }); return;
      case 'status': ui.status(msg.text); sendResponse({ ok: true }); return;
      case 'level': ui.level(msg.level, msg.speaking); sendResponse({ ok: true }); return;
      case 'interim': ui.interim(msg.text); sendResponse({ ok: true }); return;
      case 'final': handleFinal(msg.text).then(sendResponse, (e) => sendResponse({ inserted: false, error: String(e) })); return true;
      case 'fallback': {
        const names = ENGINE_NAMES;
        ui.toast((names[msg.from] || msg.from) + ' недоступен → переключаюсь на «' + (names[msg.to] || msg.to) + '»', 4000);
        sendResponse({ ok: true }); return;
      }
      case 'toast': ui.toast(msg.text); sendResponse({ ok: true }); return;
      case 'tab-session': tabActive = !!msg.active; return;
      case 'error':
        state = 'idle'; ui.setState('idle');
        ui.toast(ERR[msg.code] || msg.message || ('Ошибка: ' + msg.code), 7000);
        sendResponse({ ok: true }); return;
    }
  });

  // для автотестов и отладки (изолированный мир контент-скрипта, страница это не видит)
  self.__gvTest = { process: (t, c) => T.process(t, c, S), getContext, currentField };
})();
