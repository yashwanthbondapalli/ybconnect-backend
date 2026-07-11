const express = require('express');
const { getExperts } = require('../controllers/expertController');
const { protect } = require('../middlewares/authMiddleware');

const router = express.Router();

router.route('/')
  .get(protect, getExperts);

module.exports = router;