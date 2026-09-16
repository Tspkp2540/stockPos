const crypto = require('crypto');

const ENVELOPE_HEADER = 'x-stockpos-envelope';
const ENVELOPE_VERSION = '1';
const ENVELOPE_MARKER = '__stockpos_envelope';

const base64Url = (value) => Buffer.from(value).toString('base64url');
const fromBase64Url = (value) => Buffer.from(String(value || ''), 'base64url');
const bearerToken = (req) => {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  return scheme === 'Bearer' && token ? token : null;
};
const requestAad = (req) => Buffer.from(`${String(req.method || 'GET').toUpperCase()}:${req.path}`);
const envelopeKey = (token) => crypto
  .createHash('sha256')
  .update(`stockpos-api-envelope:v1:${token}`)
  .digest();

const encryptJson = (value, token, aad) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', envelopeKey(token), iv);
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(value === undefined ? null : value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    [ENVELOPE_MARKER]: Number(ENVELOPE_VERSION),
    iv: base64Url(iv),
    tag: base64Url(cipher.getAuthTag()),
    ciphertext: base64Url(ciphertext),
  };
};

const decryptJson = (envelope, token, aad) => {
  if (!envelope || Number(envelope[ENVELOPE_MARKER]) !== Number(ENVELOPE_VERSION)) {
    throw new Error('Encrypted payload is required');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', envelopeKey(token), fromBase64Url(envelope.iv));
  decipher.setAAD(aad);
  decipher.setAuthTag(fromBase64Url(envelope.tag));
  const plaintext = Buffer.concat([
    decipher.update(fromBase64Url(envelope.ciphertext)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
};

const createApiEnvelopeMiddleware = ({ enabled = false } = {}) => (req, res, next) => {
  const token = bearerToken(req);
  const requested = String(req.headers[ENVELOPE_HEADER] || '') === ENVELOPE_VERSION;
  const useEnvelope = enabled && requested && Boolean(token) && req.path.startsWith('/api/');
  if (!useEnvelope) return next();

  const aad = requestAad(req);
  const sendJson = res.json.bind(res);
  res.json = (payload) => {
    res.set(ENVELOPE_HEADER, ENVELOPE_VERSION);
    return sendJson(encryptJson(payload, token, aad));
  };

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  const hasJsonPayload = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase())
    && contentType.includes('application/json')
    && req.body !== undefined;
  if (!hasJsonPayload) return next();

  try {
    req.body = decryptJson(req.body, token, aad);
    return next();
  } catch (error) {
    return res.status(400).json({ success: false, error: 'Encrypted payload is invalid' });
  }
};

module.exports = {
  ENVELOPE_HEADER,
  ENVELOPE_MARKER,
  ENVELOPE_VERSION,
  createApiEnvelopeMiddleware,
  decryptJson,
  encryptJson,
};
