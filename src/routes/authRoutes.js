// backend/src/routes/authRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  registerUser,
  loginUser,
  refreshToken,
  updatePushToken,
  updateProfile,
  updatePassword,
  sendEmailOtp,
  getMe,
  updateUserEmail,
  resetPasswordWithOtp,
  sendPasswordResetOtp,
  deleteAccount,
} = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// 1. Login & Token Refresh Limiter (15 requests per 10 minutes per IP)
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again after 10 minutes.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// 2. Strict OTP Dispatch & Verification Limiter (Max 5 attempts per 15 minutes per IP)
const otpStrictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: 'Too many OTP requests or failed attempts. Please wait 15 minutes before trying again.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Public Auth Routes
router.post('/login', authLimiter, loginUser);
router.post('/refresh-token', authLimiter, refreshToken);
router.post('/register', otpStrictLimiter, registerUser);

// Public OTP Routes (Strictly Rate-Limited)
router.post('/send-otp', otpStrictLimiter, sendEmailOtp);
router.post('/send-reset-otp', otpStrictLimiter, sendPasswordResetOtp);
router.post('/reset-password-otp', otpStrictLimiter, resetPasswordWithOtp);

// Protected Authenticated Routes
router.get('/me', protect, getMe);
router.post('/push-token', protect, updatePushToken);
router.put('/update-profile', protect, updateProfile);
router.put('/update-password', protect, authLimiter, updatePassword);
router.put('/update-email', protect, otpStrictLimiter, updateUserEmail);
router.delete('/delete-account', protect, deleteAccount);

module.exports = router;