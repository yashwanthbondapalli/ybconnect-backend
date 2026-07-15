const express = require('express');
const rateLimit = require('express-rate-limit'); // <-- 1. Import the library
const { 
  registerUser, 
  loginUser, 
  updatePushToken, 
  updateProfile, 
  updatePassword,
  sendEmailOtp,
  getMe ,// <-- 1. Add this import
  updateUserEmail,
  resetPasswordWithOtp,
  sendPasswordResetOtp,
  deleteAccount // <-- ADD THIS
} = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

const { refreshToken } = require('../controllers/authController');


const router = express.Router();

// --- ENTERPRISE FIX START (Issue 8) ---
// Define a strict limiter: Maximum 5 attempts every 15 minutes per IP address
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // Limit each IP to 5 requests per window
  message: { 
    success: false, 
    error: 'Too many authentication attempts from this IP, please try again after 5 minutes.' 
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false,  // Disable the `X-RateLimit-*` headers
});
// --- ENTERPRISE FIX END ---

// 2. Inject the middleware directly into the sensitive routes
router.post('/register', authLimiter, registerUser);
router.post('/login', authLimiter, loginUser);

router.get('/me', protect, getMe);
router.post('/refresh-token', refreshToken);

// Push token route
router.post('/push-token', protect, updatePushToken);

// Settings routes
router.put('/update-profile', protect, updateProfile);
router.put('/update-password', protect, updatePassword);

router.put('/update-email', protect, updateUserEmail);
// Add the route (Usually near your other OTP routes)
// In authRoutes.js
router.post('/send-otp', authLimiter, sendEmailOtp);
router.post('/send-reset-otp', authLimiter, sendPasswordResetOtp);
router.post('/reset-password-otp', authLimiter, resetPasswordWithOtp);

// Danger Zone
router.delete('/delete-account', protect, deleteAccount);

module.exports = router;