const express = require('express');
const { getCurrentUserProfile, upsertProfile, getProfileByUserId, getProfileBySlug } = require('../controllers/profileController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

router.route('/me')
  .get(protect, getCurrentUserProfile)
  .post(protect, upsertProfile);

// NEW ENDPOINT: Fetch anyone's profile by their User ID
router.route('/user/:userId')
  .get(protect, getProfileByUserId);
  // Add this line to your routes
router.get('/slug/:slug', getProfileBySlug);

module.exports = router;