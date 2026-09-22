const express = require('express');
// Check this line! The path MUST point to the correct controller file name.
const { createProfileReport } = require('../controllers/profileReportController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// POST /api/v1/profile-reports
router.post('/', protect, createProfileReport);

module.exports = router;