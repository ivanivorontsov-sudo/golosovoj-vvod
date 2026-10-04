/* Обработка распознанного текста: голосовые команды пунктуации, пробелы, заглавные буквы.
   Классический скрипт (self.GVText) + CommonJS для юнит-тестов. */
(function (root) {
  'use strict';

  // [фраза, результат]. Результат: символ пунктуации, '\n', '\n\n' или {action}.
  const RU = [
    ['точка с запятой', ';'],
    ['вопросительный знак', '?'], ['знак вопроса', '?'],
    ['восклицательный знак', '!'], ['знак восклицания', '!'],
    ['многоточие', '…'], ['три точки', '…'],
    ['двоеточие', ':'],
    ['поставь запятую', ','], ['запятая', ','],
    ['поставь точку', '.'], ['точка', '.'],
    ['тире', '—'], ['дефис', '-'],
    ['открыть скобку', '('], ['открой скобку', '('], ['открывающая скобка', '('], ['скобка открывается', '('],
    ['закрыть скобку', ')'], ['закрой скобку', ')'], ['закрывающая скобка', ')'], ['скобка закрывается', ')'],
    ['открыть кавычки', '«'], ['открой кавычки', '«'], ['кавычки открываются', '«'], ['открывающая кавычка', '«'],
    ['закрыть кавычки', '»'], ['закрой кавычки', '»'], ['кавычки закрываются', '»'], ['закрывающая кавычка', '»'],
    ['новая строка', '\n'], ['новую строку', '\n'], ['с новой строки', '\n'], ['перенос строки', '\n'],
    ['новый абзац', '\n\n'], ['с нового абзаца', '\n\n']
  ];
  const EN = [
    ['question mark', '?'], ['exclamation mark', '!'], ['exclamation point', '!'],
    ['full stop', '.'], ['period', '.'], ['comma', ','], ['semicolon', ';'], ['colon', ':'],
    ['ellipsis', '…'], ['dash', '—'], ['hyphen', '-'],
    ['open parenthesis', '('], ['open bracket', '('], ['close parenthesis', ')'], ['close bracket', ')'],
    ['open quote', '“'], ['close quote', '”'],
    ['new line', '\n'], ['next line', '\n'], ['new paragraph', '\n\n']
  ];
  // Команды управления — только если вся фраза целиком совпадает.
  const CONTROL = {
    'стоп запись': 'stop', 'остановить запись': 'stop', 'останови запись': 'stop', 'закончить запись': 'stop', 'стоп': 'stop', 'хватит': 'stop',
    'удали последнее': 'undo', 'удалить последнее': 'undo', 'отмени последнее': 'undo', 'отменить последнее': 'undo', 'отмена': 'undo',
    'stop listening': 'stop', 'stop dictation': 'stop', 'stop recording': 'stop',
    'undo that': 'undo', 'delete that': 'undo', 'scratch that': 'undo'
  };
  // «точка зрения» и т.п. — не команда.
  const TOCHKA_EXCEPTIONS = new Set(['зрения', 'отсчета', 'отсчёта', 'опоры', 'доступа', 'кипения', 'росы', 'замерзания', 'роста', 'продаж', 'соприкосновения', 'невозврата', 'входа', 'выхода', 'g', 'джи', 'ру', 'ком', 'com', 'ru']);
  // Частые слова, которые после «запятая» Google иногда пишет с заглавной.
  const COMMON = new Set(('а и но да нет не ни же ли бы что чтобы как когда где куда откуда кто какой какая какие который которая которые ' +
    'потому почему зачем если хотя пока уже ещё еще тоже также только вот ну так то это эти этот эта тот та те все всё весь вся ' +
    'я ты он она оно мы вы они меня тебя его её ее нас вас их мне тебе ему ей нам вам им мой моя мои твой твоя твои наш ваш ' +
    'в на с со к ко по за из от до о об у при для про без над под между через или либо даже может можно нужно надо очень сейчас потом тогда ' +
    'привет спасибо пожалуйста здравствуйте пока хорошо ладно конечно ' +
    'the a an and but or so if then that this these those it is are was were i you he she we they my your our ' +
    'to of in on at for with from by as not no yes please thanks hello').split(/\s+/));

  const ATTACH = new Set([',', '.', '?', '!', ':', ';', '…', ')', '»', '”']);
  const SENTENCE_END = new Set(['.', '?', '!', '…']);
  const OPENERS = new Set(['(', '«', '“']);

  function norm(w) { return w.toLowerCase().replace(/ё/g, 'е'); }
  function stripBraces(w) { const m = /^\{(.+)\}$/.exec(w); return m ? m[1] : w; }

  function compile(list) {
    return list.map(([phrase, out]) => ({ words: phrase.split(' ').map(norm), out }))
      .sort((a, b) => b.words.length - a.words.length);
  }
  const TABLE = { ru: compile(RU), en: compile(EN) };

  function isSentenceStart(before) {
    if (!before) return true;
    if (/\n\s*$/.test(before)) return true;
    const t = before.replace(/[\s\u00A0]+$/, '');
    if (!t) return true;
    return /[.!?…]["»”')\]]*$/.test(t);
  }
  function upperFirst(w) { return w ? w.charAt(0).toLocaleUpperCase() + w.slice(1) : w; }
  function lowerFirst(w) { return w ? w.charAt(0).toLocaleLowerCase() + w.slice(1) : w; }
  function isPlainCapitalized(w) {
    // «Привет» — да; «США», «iPhone», «I», «McDonald» — нет
    if (w.length < 2) return false;
    const rest = w.slice(1);
    return w.charAt(0) !== w.charAt(0).toLowerCase() && rest === rest.toLowerCase() && /\p{L}/u.test(rest);
  }

  /** Разбивает распознанную фразу на элементы {t:'w', v} | {t:'p', v} | {t:'a', v}. */
  function tokenize(raw, lang, opts) {
    const words = String(raw || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).map(stripBraces);
    const table = TABLE[(lang || 'ru').slice(0, 2)] || TABLE.ru;
    const out = [];
    const useCmds = opts.voiceCommands !== false;
    if (useCmds) {
      const whole = norm(words.join(' ').replace(/[.,!?;:…]+$/, ''));
      if (CONTROL[whole]) return [{ t: 'a', v: CONTROL[whole] }];
    }
    for (let i = 0; i < words.length;) {
      let matched = null;
      if (useCmds) {
        for (const c of table) {
          const n = c.words.length;
          if (i + n > words.length) continue;
          let ok = true;
          for (let k = 0; k < n; k++) {
            const core = norm(words[i + k]).replace(/[.,!?;:…]+$/, '');
            if (core !== c.words[k]) { ok = false; break; }
          }
          if (!ok) continue;
          if ((c.out === '.' && c.words.length === 1) && i + 1 < words.length && TOCHKA_EXCEPTIONS.has(norm(words[i + 1]).replace(/[.,!?;:…]+$/, ''))) continue;
          matched = c; break;
        }
      }
      if (matched) {
        out.push({ t: 'p', v: matched.out, spoken: true });
        i += matched.words.length;
      } else {
        out.push({ t: 'w', v: words[i] });
        i++;
      }
    }
    return out;
  }

  /**
   * Готовит текст к вставке.
   * @param {string} raw — распознанный текст
   * @param {{before?:string, after?:string, lang?:string}} ctx — текст до/после курсора
   * @param {object} opts — voiceCommands, autoCapitalize, lowercaseMidSentence
   * @returns {{text:string, deleteBefore:number, actions:string[]}}
   */
  function process(raw, ctx, opts) {
    ctx = ctx || {}; opts = opts || {};
    const lang = ctx.lang || opts.lang || 'ru-RU';
    const before = ctx.before || '';
    const after = ctx.after || '';
    const autoCap = opts.autoCapitalize !== false;
    const lowerMid = opts.lowercaseMidSentence !== false;
    const toks = tokenize(raw, lang, opts);
    const actions = [];
    let out = '';
    let deleteBefore = 0;
    let atStart = isSentenceStart(before);
    let needSpace = before.length > 0 && !/[\s\u00A0(«“"'\[\/-]$/.test(before);
    let firstWord = true;
    let prevSpokenMid = false; // предыдущий элемент — произнесённая «запятая/двоеточие/тире»

    const trimOutEnd = () => {
      const m = /[ \u00A0]+$/.exec(out);
      if (m) out = out.slice(0, -m[0].length);
      else if (!out && /[ \u00A0]$/.test(before) && !deleteBefore) deleteBefore = 1;
    };

    for (const tk of toks) {
      if (tk.t === 'a') { actions.push(tk.v); continue; }
      if (tk.t === 'w') {
        let w = tk.v;
        if (atStart && autoCap) w = upperFirst(w);
        else if (!atStart && firstWord && lowerMid && isPlainCapitalized(w)) w = lowerFirst(w);
        else if (!atStart && prevSpokenMid && isPlainCapitalized(w) && COMMON.has(norm(w).replace(/[.,!?;:…]+$/, ''))) w = lowerFirst(w);
        if (/^i$/.test(w) && /^en/.test(lang)) w = 'I';
        if (needSpace && !/[\s(«“]$/.test(out)) out += ' ';
        out += w;
        needSpace = true;
        firstWord = false;
        prevSpokenMid = false;
        const last = w.slice(-1);
        atStart = SENTENCE_END.has(last);
        continue;
      }
      // пунктуация
      const p = tk.v;
      if (p === '\n' || p === '\n\n') {
        trimOutEnd();
        out += p;
        needSpace = false;
        atStart = true;
        prevSpokenMid = false;
        continue;
      }
      if (ATTACH.has(p)) {
        trimOutEnd();
        out += p;
        needSpace = true;
        if (SENTENCE_END.has(p)) atStart = true;
        prevSpokenMid = !SENTENCE_END.has(p);
        continue;
      }
      if (OPENERS.has(p)) {
        if (needSpace && !/\s$/.test(out)) out += ' ';
        out += p;
        needSpace = false;
        prevSpokenMid = false;
        continue;
      }
      if (p === '—') {
        if (!/\s$/.test(out) && (out || needSpace)) out += ' ';
        out += '—';
        needSpace = true;
        prevSpokenMid = true;
        continue;
      }
      if (p === '-') {
        trimOutEnd();
        out += '-';
        needSpace = false;
        prevSpokenMid = false;
        continue;
      }
      out += p;
    }
    // если сразу за курсором слово — отделяем пробелом
    if (out && /^[\p{L}\p{N}]/u.test(after) && !/[\s(«“\-]$/.test(out)) out += ' ';
    return { text: out, deleteBefore, actions };
  }

  const api = { process, tokenize, isSentenceStart };
  root.GVText = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
