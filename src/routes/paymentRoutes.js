// backend/src/routes/paymentRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  createOrder,
  verifyPayment,
  releaseEscrow,
  createLinkedAccount,
  getAdminPayouts,
  markAsPaidOut,
  razorpayWebhook,
  requestPayout,
  getRefundStats,
  requestRefundPayout,
} = require('../controllers/paymentController');
const { protect, adminOnly } = require('../middlewares/authMiddleware');

const router = express.Router();

// Rate limiter for order creation & payment verification (20 requests / 10 mins)
const paymentLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many payment requests. Please wait a few minutes and try again.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict rate limiter for wallet withdrawals & refund claims (5 requests / 15 mins)
const walletWithdrawalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: 'Too many withdrawal or refund attempts. Please wait 15 minutes.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 1. Razorpay Server-to-Server Webhook (Verified via HMAC signature in controller)
router.post('/webhook', razorpayWebhook);

// 2. Authenticated Student Payment Routes (with route aliases for full compatibility)
router.post('/create-order', protect, paymentLimiter, createOrder);
router.post('/verify', protect, paymentLimiter, verifyPayment);
router.post('/verify-payment', protect, paymentLimiter, verifyPayment);

// 3. Authenticated Mentor Payout & Student Refund Wallet Routes
router.post('/request-payout', protect, walletWithdrawalLimiter, requestPayout);
router.get('/refund-stats', protect, getRefundStats);
router.post('/request-refund', protect, walletWithdrawalLimiter, requestRefundPayout);
router.post('/link-account', protect, walletWithdrawalLimiter, createLinkedAccount);
router.post('/create-linked-account', protect, walletWithdrawalLimiter, createLinkedAccount);

// 4. Escrow Release Route (Controller verifies Paying Student or Admin)
router.post('/release-escrow', protect, releaseEscrow);

// 5. Strict Admin-Only Payout Management Routes
if (typeof getAdminPayouts === 'function') {
  router.get('/admin/payouts', protect, adminOnly, getAdminPayouts);
}
if (typeof markAsPaidOut === 'function') {
  router.put('/admin/payouts/:id', protect, adminOnly, markAsPaidOut);
}

module.exports = router;