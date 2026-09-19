const assert = require('node:assert/strict');
const test = require('node:test');
const { settlePayments } = require('../utils/paymentSettlement');

test('a transfer paid over the due amount creates a cash change record', () => {
  const payments = settlePayments({
    requestedPayments: [{ payment_method: 'TRANSFER', paid_amount: null, amount_received: 150 }],
    grossAmount: 120,
    isSplitPayment: false,
  });
  assert.deepEqual(payments[0], {
    payment_method: 'TRANSFER',
    paid_amount: 120,
    amount_received: 150,
    change_amount: 30,
    change_method: 'CASH',
    requires_cash_shift: true,
  });
});

test('payment settlement rejects an amount received below the amount due', () => {
  assert.throws(() => settlePayments({
    requestedPayments: [{ payment_method: 'TRANSFER', paid_amount: null, amount_received: 99 }],
    grossAmount: 120,
    isSplitPayment: false,
  }), /ยอดที่รับชำระต้องไม่น้อยกว่ายอดที่ต้องชำระ/);
});
