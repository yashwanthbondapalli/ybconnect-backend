const Idea = require('../models/Idea');
const User = require('../models/User'); // Assuming you have a User model
const Profile = require('../models/Profile'); // To fetch author details

// @desc    Create a new Idea
// @route   POST /api/v1/ideas
exports.createIdea = async (req, res, next) => {
  try {
    let { message, category } = req.body;

    // 1. Basic Validation
    if (!message || message.trim() === '') {
      return res.status(400).json({ success: false, error: 'Post cannot be empty.' });
    }
    
    message = message.trim();
    if (message.length > 2000) {
      return res.status(400).json({ success: false, error: 'Post exceeds 2000 characters.' });
    }

    // 2. Anti-Spam Rate Limits
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const twentySecondsAgo = new Date(Date.now() - 20 * 1000);

    const recentIdeas = await Idea.find({ 
      authorId: req.user._id, 
      createdAt: { $gte: oneDayAgo } 
    }).sort({ createdAt: -1 });

    // Check Daily Limit
    if (recentIdeas.length >= 10) {
      return res.status(429).json({ success: false, error: 'Daily limit reached. You can only post 10 ideas per day.' });
    }

    // Check Cooldown Limit
    if (recentIdeas.length > 0 && recentIdeas[0].createdAt > twentySecondsAgo) {
      return res.status(429).json({ success: false, error: 'Please wait 20 seconds before posting again.' });
    }

    // 3. Fetch User Profile Data for Snapshot
    const userProfile = await Profile.findOne({ user: req.user._id }).populate('user', 'name');
    
    const newIdea = await Idea.create({
      authorId: req.user._id,
      authorName: userProfile?.user?.name || req.user.name || 'Anonymous User',
      profileImage: userProfile?.profileImage || 'default-avatar.png',
      designation: userProfile?.designation || '',
      company: userProfile?.companyName || '',
      category: category || 'Other',
      message
    });

    res.status(201).json({ success: true, data: newIdea });
  } catch (error) {
    console.error("Create Idea Error:", error);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Get Feed (with infinite scroll & filters)
// @route   GET /api/v1/ideas
exports.getFeed = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 15;
    const startIndex = (page - 1) * limit;

    const query = {};
    
    // Filter by Category if provided
    if (req.query.category && req.query.category !== 'All Ideas') {
      query.category = req.query.category;
    }

    // Sorting Logic (Trending vs Newest)
    let sortObj = { createdAt: -1 }; // Default: Newest first
    if (req.query.sort === 'trending') {
      sortObj = { likesCount: -1, createdAt: -1 }; 
    }

    const ideas = await Idea.find(query)
      .sort(sortObj)
      .skip(startIndex)
      .limit(limit);

    res.status(200).json({ success: true, count: ideas.length, data: ideas });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Toggle Like on an Idea
// @route   PUT /api/v1/ideas/:id/like
exports.toggleLike = async (req, res, next) => {
  try {
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ success: false, error: 'Idea not found' });

    const userId = req.user._id;
    const isLiked = idea.likedBy.includes(userId);

    if (isLiked) {
      // Unlike
      idea.likedBy = idea.likedBy.filter(id => id.toString() !== userId.toString());
      idea.likesCount -= 1;
    } else {
      // Like
      idea.likedBy.push(userId);
      idea.likesCount += 1;
      
      // TODO (Future): Trigger notification to idea.authorId here
    }

    await idea.save();
    res.status(200).json({ success: true, isLiked: !isLiked, likesCount: idea.likesCount });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Search Ideas
// @route   GET /api/v1/ideas/search?q=keyword
exports.searchIdeas = async (req, res, next) => {
  try {
    const searchTerm = req.query.q;
    if (!searchTerm) return res.status(200).json({ success: true, data: [] });

    // Search text across multiple fields
    const ideas = await Idea.find({
      $or: [
        { message: { $regex: searchTerm, $options: 'i' } },
        { authorName: { $regex: searchTerm, $options: 'i' } },
        { company: { $regex: searchTerm, $options: 'i' } },
        { designation: { $regex: searchTerm, $options: 'i' } }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(20); // Cap search results to prevent lag

    res.status(200).json({ success: true, count: ideas.length, data: ideas });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Delete an Idea
// @route   DELETE /api/v1/ideas/:id
exports.deleteIdea = async (req, res, next) => {
  try {
    const idea = await Idea.findById(req.params.id);
    if (!idea) return res.status(404).json({ success: false, error: 'Idea not found' });

    // Security: Only the author can delete their idea
    if (idea.authorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, error: 'Not authorized to delete this idea' });
    }

    await idea.deleteOne();
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};