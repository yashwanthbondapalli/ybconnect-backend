const express = require('express');
const router = express.Router();
const zoomController = require('../controllers/zoomController');
const { protect } = require('../middlewares/authMiddleware'); // Your JWT protector
const { connectZoom, zoomCallback, zoomWebhook } = require('../controllers/zoomController');

// Mobile app hits this to get the URL
router.get('/connect', protect, zoomController.connectZoom);

// Zoom's server hits this publicly
router.get('/callback', zoomController.zoomCallback);

// ✅ NEW: The secret backdoor for Zoom's servers
router.post('/webhook', zoomWebhook);

module.exports = router;