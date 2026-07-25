const express = require('express');
// 🚨 FIX 1: Make sure toggleLiveStatus is imported here!
const { 
  getCurrentUserProfile, 
  upsertProfile, 
  getProfileByUserId, 
  getProfileBySlug,
  toggleLiveStatus,
  getProfileByAnyId,
  getStudentTalent,
  updateProfileImage
} = require('../controllers/profileController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();
router.get('/talent', getStudentTalent);

router.route('/me')
  .get(protect, getCurrentUserProfile)
  .post(protect, upsertProfile);

// 🚨 FIX 2: Add the toggle route right here!
router.put('/live-status', protect, toggleLiveStatus);
// 🚀 THE NEW FAST-LANE IMAGE ROUTE
router.patch('/image', protect, updateProfileImage);

// Add this line BEFORE any routes that use /:id or /:slug so it doesn't get confused!

// Fetch anyone's profile by their User ID
router.route('/user/:userId')
  .get(protect, getProfileByUserId);

  // Fetch by slug
router.get('/slug/:slug', getProfileBySlug);
// Add this at the top with your other imports

  // Add this to profileRoutes.js
router.get('/any/:id', protect, getProfileByAnyId);
  

module.exports = router;