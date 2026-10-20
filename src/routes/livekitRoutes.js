// backend/src/routes/livekitRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const {
  getCallToken,
  reportSessionEvent,
  livekitWebhook,
} = require('../controllers/livekitController');

// Public route hit by LiveKit Cloud servers (verified by cryptographic signature)
router.post('/webhook', livekitWebhook);

// Protected routes hit by the YB Connect mobile app
router.post('/token', protect, getCallToken);
router.post('/session-event', protect, reportSessionEvent);

module.exports = router;