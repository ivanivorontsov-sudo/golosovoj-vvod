/* Хранилище офлайн-моделей Vosk (IndexedDB источника расширения). self.GVModels */
(function (root) {
  const DB = 'gv-models', STORE = 'models';
  const MODELS = {
    'ru-RU': { name: 'vosk-model-small-ru-0.22', url: 'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip', sizeMb: 45 },
    'en-US': { name: 'vosk-model-small-en-us-0.15', url: 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip', sizeMb: 40 }
  };
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, mode);
      const st = t.objectStore(STORE);
      let out;
      Promise.resolve(fn(st)).then(v => { out = v; });
      t.oncomplete = () => { db.close(); res(out instanceof IDBRequest ? out.result : out); };
      t.onerror = () => { db.close(); rej(t.error); };
    });
  }
  const get = (lang) => tx('readonly', st => st.get(lang));
  const put = (lang, rec) => tx('readwrite', st => st.put(rec, lang));
  const del = async (lang) => {
    await tx('readwrite', st => st.delete(lang));
    // распакованная копия внутри Vosk (IDBFS) — удаляем всю базу, при следующем запуске распакуется снова
    await new Promise(r => { const q = indexedDB.deleteDatabase('/vosk'); q.onsuccess = q.onerror = q.onblocked = () => r(); });
  };
  async function info(lang) {
    const rec = await get(lang);
    return rec ? { installed: true, name: rec.name, size: rec.blob ? rec.blob.size : 0, date: rec.date } : { installed: false };
  }
  root.GVModels = { MODELS, get, put, del, info };
})(typeof self !== 'undefined' ? self : globalThis);
