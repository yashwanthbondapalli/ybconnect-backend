// backend/src/routes/ideaRoutes.js
const express = require('express');
const router = express.Router();

const {
  createIdea,
  updateIdea,
  getFeed,
  toggleLike,
  searchIdeas,
  deleteIdea,
} = require('../controllers/ideaController');

const { protect } = require('../middlewares/authMiddleware');

router.route('/search').get(protect, searchIdeas);

router.route('/').post(protect, createIdea).get(protect, getFeed);

router
  .route('/:id')
  .put(protect, updateIdea)
  .delete(protect, deleteIdea);

router.route('/:id/like').put(protect, toggleLike);

module.exports = router;