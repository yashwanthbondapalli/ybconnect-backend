const express = require('express');
// 🚨 FIX 1: Make sure toggleLiveStatus is imported here!
const { 
  getCurrentUserProfile, 
  upsertProfile, 
  getProfileByUserId, 
  getProfileBySlug,
  toggleLiveStatus,
  getProfileByAnyId
} = require('../controllers/profileController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

router.route('/me')
  .get(protect, getCurrentUserProfile)
  .post(protect, upsertProfile);

// 🚨 FIX 2: Add the toggle route right here!
router.put('/live-status', protect, toggleLiveStatus);

// Fetch anyone's profile by their User ID
router.route('/user/:userId')
  .get(protect, getProfileByUserId);

  // Add this to profileRoutes.js
router.get('/any/:id', protect, getProfileByAnyId);
  
// Fetch by slug
router.get('/slug/:slug', getProfileBySlug);

module.exports = router;