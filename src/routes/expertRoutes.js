const express = require('express');
const { getExperts,getLiveExperts } = require('../controllers/expertController');
const { protect } = require('../middlewares/authMiddleware');


const router = express.Router();
router.get('/live', protect, getLiveExperts);

router.route('/')
  .get(protect, getExperts);

module.exports = router;