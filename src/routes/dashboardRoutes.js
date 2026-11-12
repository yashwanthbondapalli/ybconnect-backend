// backend/src/routes/dashboardRoutes.js
const express = require('express');
const router = express.Router();
const { protect } = require('../middlewares/authMiddleware');
const { getExpertDashboard } = require('../controllers/dashboardController');

router.get('/expert/dashboard', protect, getExpertDashboard);

module.exports = router;