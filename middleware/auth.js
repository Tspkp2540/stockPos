const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const TOKEN_TTL_SECONDS = 60 * 60 * 12;
const roles = new Set(['ADMIN', 'STAFF', 'USER']);

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (value) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const secret = () => process.env.AUTH_SECRET;

const hashLegacyPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
};

const verifyLegacyPassword = (password, stored) => {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = hashLegacyPassword(password, salt).split('$')[2];
  const storedBuffer = Buffer.from(hash, 'hex');
  const candidateBuffer = Buffer.from(candidate, 'hex');
  return storedBuffer.length === candidateBuffer.length && storedBuffer.length > 0 && crypto.timingSafeEqual(storedBuffer, candidateBuffer);
};

const hashPassword = (password) => bcrypt.hashSync(password, 12);

const verifyPassword = (password, stored) => {
  const storedHash = String(stored || '');
  if (storedHash.startsWith('$2')) return bcrypt.compareSync(password, storedHash);
  return verifyLegacyPassword(password, storedHash);
};

const needsPasswordUpgrade = (stored) => String(stored || '').startsWith('scrypt$');

const createToken = (user) => {
  if (!secret()) throw new Error('AUTH_SECRET is not configured');
  const payload = {
    sub: Number(user.id),
    username: user.username,
    role: user.role,
    roleKey: user.role_key || user.role,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const body = encode(payload);
  const signature = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${signature}`;
};

const verifyToken = (token) => {
  if (!secret()) throw new Error('AUTH_SECRET is not configured');
  const [body, signature] = String(token || '').split('.');
  if (!body || !signature) throw new Error('Invalid token');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) throw new Error('Invalid token');
  const payload = decode(body);
  if (!Number.isInteger(payload.sub) || !roles.has(payload.role) || !/^[A-Z][A-Z0-9_]{0,31}$/.test(String(payload.roleKey || payload.role)) || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Expired token');
  return payload;
};

const requireAuth = (req, res, next) => {
  try {
    const [type, token] = String(req.headers.authorization || '').split(' ');
    if (type !== 'Bearer' || !token) throw new Error('Missing token');
    req.user = verifyToken(token);
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Authentication required' });
  }
};

const requireRoles = (...allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) return res.status(403).json({ success: false, error: 'Insufficient permission' });
  next();
};

module.exports = { hashPassword, verifyPassword, needsPasswordUpgrade, createToken, verifyToken, requireAuth, requireRoles };
