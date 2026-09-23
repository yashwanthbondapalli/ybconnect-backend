const express = require('express');
const { 
  createCallRequest, 
  getRequests, 
  updateRequestStatus,
  createInstantHold,
  submitReview,
  getExpertReviews, // 🚨 NEW: Fetch Reviews
  deleteReview,    // 🚨 NEW: Delete Review
  sendNudge
} = require('../controllers/requestController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

// Apply protection to all routes in this file
router.use(protect);

router.route('/')
  .post(createCallRequest)
  .get(getRequests);

// 🚨 NEW: Public (but protected) route to fetch an expert's reviews and stats
router.get('/expert/:expertId/reviews', getExpertReviews);

router.route('/:id/status')
  .put(updateRequestStatus);

// Instant Booking Temporary Hold
router.post('/instant-hold', createInstantHold);

// 🚨 UPDATED: Chained the POST (submit) and DELETE (remove) methods to the review route
router.route('/:id/review')
  .post(submitReview)
  .delete(deleteReview);


  router.post('/:id/nudge', sendNudge);

  

module.exports = router;