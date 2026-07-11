// src/routes/dashboardRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware'); // Your JWT protector
const { getExpertDashboard } = require('../controllers/dashboardController');

// This maps the GET request to your controller!
router.get('/expert/dashboard', protect, getExpertDashboard);

module.exports = router;