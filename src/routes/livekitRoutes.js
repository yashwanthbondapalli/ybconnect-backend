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

// 1. Issue short-lived LiveKit room token for authorized Mentor/Student (Mobile App)
router.post('/token', protect, livekitController.getCallToken);

// 2. Record in-app join, 15s heartbeat, and leave events (Mobile App)
router.post('/session-event', protect, livekitController.reportSessionEvent);

// 3. Generate encrypted, single-user Laptop Browser Link (Mobile App -> Clipboard)
router.post('/web-link', protect, livekitController.createWebCallLink);

// 4. Exchange signed Web Ticket for a 1:1 LiveKit Token (Next.js Website)
router.post('/web-token', livekitController.getWebCallToken);

// 5. Record browser join, 15s heartbeat, leave, and quota errors (Next.js Website)
router.post('/web-session-event', livekitController.reportWebSessionEvent);

// 6. Authoritative LiveKit Server Webhook
router.post('/webhook', livekitController.livekitWebhook);

module.exports = router;