// backend/src/routes/profileRoutes.js
const express = require('express');
const {
  getCurrentUserProfile,
  upsertProfile,
  getProfileByUserId,
  getProfileBySlug,
  toggleLiveStatus,
  getProfileByAnyId,
  getStudentTalent,
  updateProfileImage,
  getExpertSlots,
  submitMentorApplication,
  reviewMentorApplication,
} = require('../controllers/profileController');

const { protect, adminOnly } = require('../middlewares/authMiddleware');

const router = express.Router();

router.get('/talent', getStudentTalent);

router
  .route('/me')
  .get(protect, getCurrentUserProfile)
  .post(protect, upsertProfile);

// Mentor Verification & Interview Routes
router.post('/mentor-application', protect, submitMentorApplication);
router.put('/mentor-application/:userId/review', protect, adminOnly, reviewMentorApplication);

router.put('/live-status', protect, toggleLiveStatus);
router.patch('/image', protect, updateProfileImage);

router.get('/user/:id/slots', getExpertSlots);
router.route('/user/:userId').get(protect, getProfileByUserId);
router.get('/slug/:slug', getProfileBySlug);
router.get('/any/:id', protect, getProfileByAnyId);

module.exports = router;