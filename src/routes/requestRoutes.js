const express = require('express');
const { createCallRequest, getRequests, updateRequestStatus } = require('../controllers/requestController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

router.use(protect);

router.route('/')
  .post(createCallRequest)
  .get(getRequests);

router.route('/:id/status')
  .put(updateRequestStatus);

module.exports = router;