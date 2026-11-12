// backend/src/routes/livekitRoutes.js
const express = require('express');
const router = express.Router();

const livekitController = require('../controllers/livekitController');
const authMiddleware = require('../middlewares/authMiddleware');

// Automatically handle both `module.exports = protect` and `exports.protect = protect`
const protect =
  typeof authMiddleware === 'function'
    ? authMiddleware
    : authMiddleware.protect || authMiddleware.auth || authMiddleware.verifyToken;

if (typeof protect !== 'function') {
  console.error(
    '❌ ERROR: authMiddleware did not export a valid function. Loaded value:',
    authMiddleware
  );
}

if (typeof livekitController.getCallToken !== 'function') {
  console.error(
    '❌ ERROR: livekitController functions are missing (make sure livekitController.js is saved!). Loaded value:',
    livekitController
  );
}

// 1. Issue short-lived LiveKit room token for authorized Mentor/Student
router.post('/token', protect, livekitController.getCallToken);

// 2. Record in-app join, 15s heartbeat, and leave events
router.post('/session-event', protect, livekitController.reportSessionEvent);

// 3. Authoritative LiveKit Server Webhook
router.post('/webhook', livekitController.livekitWebhook);

module.exports = router;