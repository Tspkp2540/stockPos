const assert = require('node:assert/strict');
const test = require('node:test');
const {
  couponDiscountFor,
  loyaltyDiscountForPoints,
  loyaltyPointsForOrder,
  normalizeCouponCode,
  normalizePaymentMethod,
  validateCouponForAmount,
  validateLoyaltySettings,
} = require('../utils/commerceRules');

const activeCoupon = {
  is_active: true,
  discount_type: 'PERCENT',
  discount_value: 20,
  min_order_amount: 100,
  max_discount_amount: 30,
  usage_limit: null,
  used_count: 0,
};

test('coupon rules calculate percentage discounts and respect the cap', () => {
  assert.equal(couponDiscountFor(activeCoupon, 250), 30);
  assert.equal(couponDiscountFor({ ...activeCoupon, discount_type: 'AMOUNT', discount_value: 500 }, 120), 30);
  assert.equal(validateCouponForAmount(activeCoupon, 200), 30);
});

test('coupon rules reject inactive, expired, exhausted, and too-small orders', () => {
  const now = new Date('2026-09-09T12:00:00.000Z');
  assert.throws(() => validateCouponForAmount({ ...activeCoupon, is_active: false }, 200, now), { message: 'Coupon is not available', statusCode: 400 });
  assert.throws(() => validateCouponForAmount({ ...activeCoupon, valid_until: '2026-09-08T23:59:59.000Z' }, 200, now), /expired/);
  assert.throws(() => validateCouponForAmount({ ...activeCoupon, usage_limit: 2, used_count: 2 }, 200, now), /usage limit/);
  assert.throws(() => validateCouponForAmount(activeCoupon, 99, now), /minimum order/);
});

test('loyalty rules earn points by spend or configured cups', () => {
  assert.equal(loyaltyPointsForOrder({ amount: 125, cups: 0 }, { earn_mode: 'SPEND', spend_per_point: 25 }), 5);
  assert.equal(loyaltyPointsForOrder({ amount: 999, cups: 5 }, { earn_mode: 'CUP', cups_per_point: 2 }), 2);
  assert.equal(loyaltyPointsForOrder({ amount: -1, cups: -1 }, { earn_mode: 'SPEND', spend_per_point: 25 }), 0);
  assert.equal(loyaltyDiscountForPoints(17, { baht_per_point: 0.25 }), 4.25);
});

test('loyalty settings normalize valid values and reject invalid limits', () => {
  assert.deepEqual(validateLoyaltySettings({
    is_enabled: true,
    earn_mode: 'cup',
    spend_per_point: '25.678',
    cups_per_point: '2',
    baht_per_point: '0.1',
    max_redeem_percent: '50',
  }), {
    is_enabled: true,
    earn_mode: 'CUP',
    spend_per_point: 25.68,
    cups_per_point: 2,
    baht_per_point: 0.1,
    max_redeem_percent: 50,
  });
  assert.throws(() => validateLoyaltySettings({ is_enabled: 'true', earn_mode: 'SPEND', spend_per_point: 25, cups_per_point: 1, baht_per_point: 0.1, max_redeem_percent: 50 }), /true or false/);
  assert.throws(() => validateLoyaltySettings({ is_enabled: true, earn_mode: 'GIFT', spend_per_point: 25, cups_per_point: 1, baht_per_point: 0.1, max_redeem_percent: 50 }), /earn mode/);
  assert.throws(() => validateLoyaltySettings({ is_enabled: true, earn_mode: 'SPEND', spend_per_point: 25, cups_per_point: 0, baht_per_point: 0.1, max_redeem_percent: 50 }), /Cups per point/);
});

test('payment and coupon normalization accept supported values and reject invalid input', () => {
  assert.equal(normalizeCouponCode(' tea 10 '), 'TEA10');
  assert.equal(normalizePaymentMethod(' qr '), 'QR');
  assert.equal(normalizePaymentMethod(), 'OTHER');
  assert.throws(() => normalizePaymentMethod('CRYPTO'), /Payment method is invalid/);
});
