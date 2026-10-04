// Юнит-тесты обработки текста: node --test tests/unit
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../extension/common/textproc.js');
const P = (raw, ctx, opts) => T.process(raw, ctx || {}, opts || {});

test('русская пунктуация и заглавная буква', () => {
  assert.equal(P('привет запятая как дела вопросительный знак').text, 'Привет, как дела?');
});
test('исключение «точка зрения» не превращается в точку', () => {
  assert.equal(P('точка зрения такова').text, 'Точка зрения такова');
});
test('новая строка и новый абзац', () => {
  assert.equal(P('новая строка дальше', { before: 'Текст.' }).text, '\nДальше');
  assert.equal(P('новый абзац тест', { before: 'А.' }).text, '\n\nТест');
});
test('продолжение предложения: пробел и строчная буква', () => {
  assert.equal(P('и ещё', { before: 'Привет' }).text, ' и ещё');
  assert.equal(P('Привет', { before: 'Ок, ' }).text, 'привет');
});
test('знак препинания удаляет пробел перед собой', () => {
  const r = P('восклицательный знак', { before: 'Ура ' });
  assert.equal(r.text, '!'); assert.equal(r.deleteBefore, 1);
});
test('кавычки-ёлочки', () => {
  assert.equal(P('открыть кавычки цитата закрыть кавычки').text, '«Цитата»');
});
test('пробел перед словом справа от курсора', () => {
  assert.equal(P('мир', { after: 'дом' }).text, 'Мир ');
});
test('команды управления', () => {
  assert.deepEqual(P('стоп запись').actions, ['stop']);
  assert.deepEqual(P('удали последнее').actions, ['undo']);
});
test('английский режим', () => {
  assert.equal(P('hello comma how are you question mark', { lang: 'en-US' }).text, 'Hello, how are you?');
});
test('отключение голосовых команд и автозаглавных', () => {
  assert.equal(P('привет запятая', {}, { voiceCommands: false }).text, 'Привет запятая');
  assert.equal(P('привет', {}, { autoCapitalize: false }).text, 'привет');
});
test('фигурные скобки {comma} от движков убираются', () => {
  assert.ok(!/[{}]/.test(P('привет {comma} мир').text));
});
