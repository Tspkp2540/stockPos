const { requestError } = require('./commerceRules');

const cashChangeEligibleMethods = new Set(['CASH', 'QR', 'TRANSFER']);
const money = (value) => Number(Number(value || 0).toFixed(2));

const settlePayments = ({ requestedPayments, grossAmount, isSplitPayment }) => {
  const dueAmount = money(Math.max(0, grossAmount));
  const paymentTotal = requestedPayments.reduce((sum, payment) => sum + (payment.paid_amount ?? 0), 0);
  if (isSplitPayment && Math.abs(paymentTotal - dueAmount) > 0.005) {
    throw requestError('ยอดชำระรวมต้องเท่ากับยอดสุทธิของออเดอร์');
  }

  const finalized = requestedPayments.map((payment) => ({
    ...payment,
    paid_amount: money(payment.paid_amount === null ? dueAmount : payment.paid_amount),
  }));
  if (finalized.some((payment) => payment.paid_amount <= 0) && dueAmount > 0) {
    throw requestError('ยอดชำระแต่ละช่องทางต้องมากกว่า 0');
  }

  return finalized.map((payment) => {
    const amountReceived = money(payment.amount_received === null ? payment.paid_amount : payment.amount_received);
    if (!Number.isFinite(amountReceived) || amountReceived < payment.paid_amount) {
      throw requestError('ยอดที่รับชำระต้องไม่น้อยกว่ายอดที่ต้องชำระ');
    }
    const changeAmount = money(amountReceived - payment.paid_amount);
    if (changeAmount > 0 && !cashChangeEligibleMethods.has(payment.payment_method)) {
      throw requestError('การทอนเงินสดรองรับเฉพาะเงินสด QR หรือโอนเงิน');
    }
    return {
      ...payment,
      amount_received: amountReceived,
      change_amount: changeAmount,
      change_method: changeAmount > 0 ? 'CASH' : null,
      requires_cash_shift: payment.payment_method === 'CASH' || changeAmount > 0,
    };
  });
};

module.exports = { settlePayments };
