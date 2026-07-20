const express = require('express');
const { createReport } = require('../controllers/reportController');
const { protect } = require('../middlewares/authMiddleware'); 

const router = express.Router();

// Route: POST /api/v1/reports
router.post('/', protect, createReport);

module.exports = router;