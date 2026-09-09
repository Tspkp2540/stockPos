const assert = require('node:assert/strict');
const test = require('node:test');

process.env.AUTH_SECRET = 'stockpos-unit-test-secret';

const {
  createToken,
  hashPassword,
  requireAuth,
  requireRoles,
  verifyPassword,
  verifyToken,
} = require('../middleware/auth');

test('bcrypt password verification accepts only the correct password', () => {
  const hash = hashPassword('User@123');
  assert.equal(hash.startsWith('$2'), true);
  assert.equal(verifyPassword('User@123', hash), true);
  assert.equal(verifyPassword('incorrect-password', hash), false);
});

test('a valid token preserves the authenticated user identity and role', () => {
  const token = createToken({ id: 42, username: 'staff01', role: 'STAFF', role_key: 'STAFF' });
  const payload = verifyToken(token);
  assert.equal(payload.sub, 42);
  assert.equal(payload.username, 'staff01');
  assert.equal(payload.role, 'STAFF');
});

test('a modified token is rejected', () => {
  const token = createToken({ id: 1, username: 'admin01', role: 'ADMIN' });
  assert.throws(() => verifyToken(`${token}changed`), /Invalid token/);
});

test('role middleware rejects a role without permission', () => {
  const result = { statusCode: null, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(body) { result.body = body; },
  };
  let reachedNext = false;
  requireRoles('ADMIN')({ user: { role: 'STAFF' } }, res, () => { reachedNext = true; });
  assert.equal(reachedNext, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.success, false);
});

test('authentication middleware rejects missing credentials and accepts a valid bearer token', () => {
  const denied = { code: null };
  requireAuth({ headers: {} }, {
    status(code) { denied.code = code; return this; },
    json() {},
  }, () => assert.fail('next must not run without a token'));
  assert.equal(denied.code, 401);

  const token = createToken({ id: 8, username: 'admin01', role: 'ADMIN' });
  const request = { headers: { authorization: `Bearer ${token}` } };
  let reachedNext = false;
  requireAuth(request, {}, () => { reachedNext = true; });
  assert.equal(reachedNext, true);
  assert.equal(request.user.sub, 8);
});
