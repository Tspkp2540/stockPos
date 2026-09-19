const test = require('node:test');
const assert = require('node:assert/strict');
const { askSystemAssistant, extractOutputText, normalizeView, safetyIdentifierFor } = require('../utils/assistantAi');

test('extractOutputText reads a Responses API output message', () => {
  assert.equal(extractOutputText({ output: [{ content: [{ type: 'output_text', text: 'ตอบแล้ว' }] }] }), 'ตอบแล้ว');
});

test('assistant sanitizes the view and sends only its bounded question', async () => {
  let request;
  const result = await askSystemAssistant({
    apiKey: 'test-key', userId: 42, role: 'staff', view: 'not-a-page', question: '  เปิด   ออเดอร์  อย่างไร ',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ model: 'gpt-5-mini', output_text: 'ไปหน้า POS' }) };
    },
  });
  assert.equal(result.answer, 'ไปหน้า POS');
  assert.equal(request.input, 'เปิด ออเดอร์ อย่างไร');
  assert.match(request.instructions, /current screen is home/);
  assert.equal(request.store, false);
  assert.equal(request.safety_identifier, safetyIdentifierFor(42));
});

test('assistant rejects missing configuration and questions that are too long', async () => {
  await assert.rejects(() => askSystemAssistant({ question: 'ช่วยด้วย' }), { code: 'ASSISTANT_NOT_CONFIGURED' });
  await assert.rejects(() => askSystemAssistant({ apiKey: 'key', question: 'ก'.repeat(801) }), { code: 'ASSISTANT_QUESTION_TOO_LONG' });
  assert.equal(normalizeView('kitchen'), 'kitchen');
  assert.equal(normalizeView('unknown'), 'home');
});
