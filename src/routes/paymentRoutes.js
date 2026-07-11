const express = require('express');
const { createOrder, verifyPayment,releaseEscrow,createLinkedAccount,getAdminPayouts,
  markAsPaidOut,
  razorpayWebhook} = require('../controllers/paymentController');
const { protect } = require('../middlewares/authMiddleware'); // Ensures only logged-in users can pay
// Add this line to your routes file
const { requestPayout } = require('../controllers/paymentController');


const router = express.Router();
// 🚨 UNPROTECTED ROUTE: Razorpay servers will hit this directly
router.post('/webhook', razorpayWebhook);
// The mobile app will hit these URLs
router.post('/create-order', protect, createOrder);
router.post('/verify', protect, verifyPayment);
// Inside paymentRoutes.js
// Ensure this route is protected by your JWT middleware
router.post('/request-payout', protect, requestPayout);
// 🚨 Make sure this exact line exists and the file is SAVED!
router.post('/link-account', protect, createLinkedAccount);
// Add this to your existing routes
router.post('/release-escrow', protect, releaseEscrow);



module.exports = router;