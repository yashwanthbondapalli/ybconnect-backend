const express = require('express');
const multer = require('multer');
const { analyzeResume } = require('../controllers/reviewer.controller');
// Import your existing auth middleware
const { protect } = require('../../../middlewares/authMiddleware');
const AtsSkill = require('../../../models/AtsSkill'); // Adjust path to your model

const router = express.Router();

// Configure Multer for Memory Storage (No disk I/O bottlenecks)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { 
        fileSize: 5 * 1024 * 1024 // 5MB hard limit for safety
    },
    fileFilter: (req, file, cb) => {
        // Strict validation: Only accept PDFs and Word Docs
        if (
            file.mimetype === 'application/pdf' ||
            file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
            file.mimetype === 'application/msword'
        ) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only PDF and DOCX are allowed.'));
        }
    }
});

// The single endpoint for the mobile app
// POST /api/v1/resume-reviewer/analyze
router.post(
    '/analyze', 
    protect, // Ensure the user is logged into YB Connect
    upload.fields([{ name: 'resume', maxCount: 1 }]), 
    analyzeResume
);

module.exports = router;