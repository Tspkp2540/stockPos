const requestError = (message, statusCode = 400) =>
  Object.assign(new Error(message), { statusCode });

const DEFAULT_LOYALTY_RULES = Object.freeze({
  is_enabled: true,
  earn_enabled: true,
  redeem_enabled: true,
  earn_mode: 'SPEND',
  spend_per_point: 25,
  cups_per_point: 1,
  baht_per_point: 0.1,
  max_redeem_percent: 50,
});

const normalizeCouponCode = (value) =>
  String(value || '').trim().toUpperCase().replace(/\s+/g, '');

const loyaltyRules = (settings = DEFAULT_LOYALTY_RULES) => ({
  is_enabled: settings.is_enabled !== false,
  earn_enabled: settings.earn_enabled !== undefined ? settings.earn_enabled === true : settings.is_enabled !== false,
  redeem_enabled: settings.redeem_enabled !== undefined ? settings.redeem_enabled === true : settings.is_enabled !== false,
  earn_mode: String(settings.earn_mode || DEFAULT_LOYALTY_RULES.earn_mode).toUpperCase() === 'CUP' ? 'CUP' : 'SPEND',
  spend_per_point: Number(settings.spend_per_point || DEFAULT_LOYALTY_RULES.spend_per_point),
  cups_per_point: Number(settings.cups_per_point || DEFAULT_LOYALTY_RULES.cups_per_point),
  baht_per_point: Number(settings.baht_per_point || DEFAULT_LOYALTY_RULES.baht_per_point),
  max_redeem_percent: Number(settings.max_redeem_percent ?? DEFAULT_LOYALTY_RULES.max_redeem_percent),
});

const loyaltyPointsForOrder = ({ amount, cups }, rules) => {
  const activeRules = loyaltyRules(rules);
  const basis = activeRules.earn_mode === 'CUP'
    ? Math.max(0, Number(cups) || 0) / activeRules.cups_per_point
    : Math.max(0, Number(amount) || 0) / activeRules.spend_per_point;
  return Math.floor(basis);
};

const loyaltyDiscountForPoints = (points, rules) => Number((
  Math.max(0, Number(points) || 0) * loyaltyRules(rules).baht_per_point
).toFixed(2));

const validateLoyaltySettings = (value = {}) => {
  const legacyIsEnabled = value.is_enabled;
  const earnEnabled = value.earn_enabled === undefined ? legacyIsEnabled : value.earn_enabled;
  const redeemEnabled = value.redeem_enabled === undefined ? legacyIsEnabled : value.redeem_enabled;
  const earnMode = String(value.earn_mode || 'SPEND').trim().toUpperCase();
  const spendPerPoint = Number(value.spend_per_point);
  const cupsPerPoint = Number(value.cups_per_point);
  const bahtPerPoint = Number(value.baht_per_point);
  const maxRedeemPercent = Number(value.max_redeem_percent);
  if (typeof earnEnabled !== 'boolean' || typeof redeemEnabled !== 'boolean') throw requestError('Loyalty earn and redeem settings must be true or false');
  if (!['SPEND', 'CUP'].includes(earnMode)) throw requestError('Loyalty earn mode must be SPEND or CUP');
  if (!Number.isFinite(spendPerPoint) || spendPerPoint < 0.01 || spendPerPoint > 1000000) {
    throw requestError('Spend per point must be between 0.01 and 1,000,000');
  }
  if (!Number.isFinite(bahtPerPoint) || bahtPerPoint < 0.01 || bahtPerPoint > 100000) {
    throw requestError('Discount value per point must be between 0.01 and 100,000');
  }
  if (!Number.isFinite(cupsPerPoint) || cupsPerPoint < 1 || cupsPerPoint > 100000) {
    throw requestError('Cups per point must be between 1 and 100,000');
  }
  if (!Number.isFinite(maxRedeemPercent) || maxRedeemPercent < 0 || maxRedeemPercent > 100) {
    throw requestError('Maximum redemption percentage must be between 0 and 100');
  }
  return {
    is_enabled: earnEnabled || redeemEnabled,
    earn_enabled: earnEnabled,
    redeem_enabled: redeemEnabled,
    earn_mode: earnMode,
    spend_per_point: Number(spendPerPoint.toFixed(2)),
    cups_per_point: Number(cupsPerPoint.toFixed(2)),
    baht_per_point: Number(bahtPerPoint.toFixed(2)),
    max_redeem_percent: Number(maxRedeemPercent.toFixed(2)),
  };
};

const paymentMethods = new Set(['CASH', 'QR', 'TRANSFER', 'CARD', 'OTHER']);
const normalizePaymentMethod = (value) => {
  const method = String(value || 'OTHER').trim().toUpperCase();
  if (!paymentMethods.has(method)) throw requestError('Payment method is invalid');
  return method;
};

const couponDiscountFor = (coupon, amount) => {
  const base = Math.max(0, Number(amount) || 0);
  const value = Math.max(0, Number(coupon?.discount_value) || 0);
  const rawDiscount = coupon?.discount_type === 'PERCENT' ? base * Math.min(value, 100) / 100 : value;
  const maxDiscount = Number(coupon?.max_discount_amount || 0);
  return Math.min(base, maxDiscount > 0 ? Math.min(rawDiscount, maxDiscount) : rawDiscount);
};

const validateCouponForAmount = (coupon, amount, now = new Date()) => {
  if (!coupon || !coupon.is_active) throw requestError('Coupon is not available');
  if (coupon.valid_from && new Date(coupon.valid_from) > now) throw requestError('Coupon has not started yet');
  if (coupon.valid_until && new Date(coupon.valid_until) < now) throw requestError('Coupon has expired');
  if (coupon.usage_limit !== null && Number(coupon.used_count) >= Number(coupon.usage_limit)) throw requestError('Coupon usage limit has been reached');
  if (Number(amount) < Number(coupon.min_order_amount || 0)) throw requestError(`Coupon requires a minimum order of ${Number(coupon.min_order_amount || 0).toFixed(2)}`);
  return couponDiscountFor(coupon, amount);
};

module.exports = {
  DEFAULT_LOYALTY_RULES,
  couponDiscountFor,
  loyaltyDiscountForPoints,
  loyaltyPointsForOrder,
  loyaltyRules,
  normalizeCouponCode,
  normalizePaymentMethod,
  requestError,
  validateCouponForAmount,
  validateLoyaltySettings,
};
