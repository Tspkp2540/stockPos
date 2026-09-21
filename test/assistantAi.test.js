const test = require('node:test');
const assert = require('node:assert/strict');
const { askSystemAssistant, extractOutputText, extractOllamaText, normalizeView, providerFailure, safetyIdentifierFor } = require('../utils/assistantAi');

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
  assert.deepEqual(request.input, [{ role: 'user', content: 'เปิด ออเดอร์ อย่างไร' }]);
  assert.match(request.instructions, /current screen is home/);
  assert.equal(request.store, false);
  assert.equal(request.safety_identifier, safetyIdentifierFor(42));
});

test('assistant sends the handbook to Ollama through the private chat API', async () => {
  let url;
  let options;
  const result = await askSystemAssistant({
    provider: 'ollama',
    ollamaBaseUrl: 'http://ollama.railway.internal:11434/',
    model: 'llama3.2:1b',
    role: 'staff', view: 'pos', question: 'รับออเดอร์อย่างไร',
    fetchImpl: async (nextUrl, nextOptions) => {
      url = nextUrl;
      options = nextOptions;
      return { ok: true, json: async () => ({ model: 'llama3.2:1b', message: { content: 'เลือกเมนูใน POS' } }) };
    },
  });
  const request = JSON.parse(options.body);
  assert.equal(url, 'http://ollama.railway.internal:11434/api/chat');
  assert.equal(options.headers.Authorization, undefined);
  assert.equal(request.stream, false);
  assert.equal(request.messages[0].role, 'system');
  assert.match(request.messages[0].content, /StockPOS handbook/);
  assert.equal(request.messages[1].content, 'รับออเดอร์อย่างไร');
  assert.deepEqual(result, { answer: 'เลือกเมนูใน POS', model: 'llama3.2:1b', provider: 'ollama' });
  assert.equal(extractOllamaText({ message: { content: 'ตอบแล้ว' } }), 'ตอบแล้ว');
});

test('assistant limits chat history and sends approved aggregate context', async () => {
  let request;
  await askSystemAssistant({
    provider: 'ollama', ollamaBaseUrl: 'http://ollama:11434', question: 'สรุปให้หน่อย',
    history: Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `ข้อความ ${index}` })),
    systemContext: ['ออเดอร์ค้าง 2 รายการ'],
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true, json: async () => ({ message: { content: 'สรุปแล้ว' } }) };
    },
  });
  assert.equal(request.messages.filter((message) => message.role === 'user' || message.role === 'assistant').length, 7);
  assert.match(request.messages[1].content, /ออเดอร์ค้าง 2 รายการ/);
});

test('assistant rejects missing configuration and questions that are too long', async () => {
  await assert.rejects(() => askSystemAssistant({ question: 'ช่วยด้วย' }), { code: 'ASSISTANT_NOT_CONFIGURED' });
  await assert.rejects(() => askSystemAssistant({ provider: 'ollama', question: 'ช่วยด้วย' }), { code: 'ASSISTANT_OLLAMA_NOT_CONFIGURED' });
  await assert.rejects(() => askSystemAssistant({ apiKey: 'key', question: 'ก'.repeat(801) }), { code: 'ASSISTANT_QUESTION_TOO_LONG' });
  assert.equal(normalizeView('kitchen'), 'kitchen');
  assert.equal(normalizeView('unknown'), 'home');
});

test('assistant translates upstream failures into safe, actionable messages', () => {
  assert.deepEqual(
    { statusCode: providerFailure(401).statusCode, code: providerFailure(401).code },
    { statusCode: 503, code: 'ASSISTANT_API_KEY_INVALID' },
  );
  assert.equal(providerFailure(429, { error: { code: 'insufficient_quota' } }).code, 'ASSISTANT_QUOTA_EXHAUSTED');
  assert.equal(providerFailure(404, { error: { code: 'model_not_found' } }).code, 'ASSISTANT_MODEL_UNAVAILABLE');
});
