const express = require('express');
const router = express.Router();

// Import the controller functions
const {
  createIdea,
  getFeed,
  toggleLike,
  searchIdeas,
  deleteIdea
} = require('../controllers/ideaController');

// Import your authentication middleware
// Note: Adjust this path if your auth middleware is located somewhere else!
const { protect } = require('../middlewares/authMiddleware'); 

// ==========================================
// IDEA HUB ROUTES (Base: /api/v1/ideas)
// ==========================================

// 🚨 IMPORTANT: The '/search' route must come BEFORE '/:id' 
// Otherwise, Express will think "search" is an Idea ID!
router.route('/search')
  .get(protect, searchIdeas);

router.route('/')
  .post(protect, createIdea)
  .get(protect, getFeed);

router.route('/:id')
  .delete(protect, deleteIdea);

router.route('/:id/like')
  .put(protect, toggleLike);

module.exports = router;