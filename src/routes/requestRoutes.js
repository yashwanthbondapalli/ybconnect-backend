const express = require('express');
const { createCallRequest, getRequests, updateRequestStatus,createInstantHold } = require('../controllers/requestController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

router.use(protect);

router.route('/')
  .post(createCallRequest)
  .get(getRequests);

router.route('/:id/status')
  .put(updateRequestStatus);

  // Instant Booking Temporary Hold
router.post('/instant-hold', protect, createInstantHold);

module.exports = router;