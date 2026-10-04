/* Общие настройки «Голосового ввода». Классический скрипт: задаёт self.GV_DEFAULTS. */
(function (root) {
  const GV_DEFAULTS = {
    engine: 'auto',            // auto | google | google-local | google-cloud | vosk
    lang: 'ru-RU',             // ru-RU | en-US
    cloudApiKey: '',
    cloudPunctuation: true,
    showMicButton: true,
    voiceCommands: true,
    autoCapitalize: true,
    lowercaseMidSentence: true,
    interimPreview: true,
    silenceStopSec: 15,        // 0 = не останавливать по тишине
    pageHotkey: 'Alt+Shift+KeyV',
    escStops: true,
    sounds: true,
    webspeechStatus: 'unknown' // unknown | ok | unavailable (заполняется автоматически)
  };
  const ENGINE_NAMES = {
    'google': 'Google (Web Speech)',
    'google-local': 'Google на устройстве',
    'google-cloud': 'Google Cloud',
    'vosk': 'Офлайн (Vosk)',
    'mock': 'Тестовый'
  };
  root.GV_DEFAULTS = GV_DEFAULTS;
  root.GV_ENGINE_NAMES = ENGINE_NAMES;
  if (typeof module !== 'undefined') module.exports = { GV_DEFAULTS, ENGINE_NAMES };
})(typeof self !== 'undefined' ? self : globalThis);
