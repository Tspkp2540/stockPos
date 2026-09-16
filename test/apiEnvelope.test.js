const assert = require('node:assert/strict');
const test = require('node:test');
const { decryptJson, encryptJson } = require('../middleware/apiEnvelope');

const token = 'test-session-token';
const aad = Buffer.from('POST:/api/orders');

test('API envelope encrypts and decrypts a JSON payload with the current session token', () => {
  const source = { customer_phone: '0812345678', items: [{ product_id: 7, quantity: 2 }] };
  const envelope = encryptJson(source, token, aad);
  assert.notEqual(envelope.ciphertext, JSON.stringify(source));
  assert.deepEqual(decryptJson(envelope, token, aad), source);
});

test('API envelope rejects a different session token or a modified encrypted payload', () => {
  const envelope = encryptJson({ amount: 120 }, token, aad);
  assert.throws(() => decryptJson(envelope, 'another-session-token', aad));
  assert.throws(() => decryptJson({ ...envelope, ciphertext: `${envelope.ciphertext}x` }, token, aad));
});
