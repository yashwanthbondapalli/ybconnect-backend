const Profile = require('../models/Profile');

exports.getExperts = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const startIndex = (page - 1) * limit;

    // 🚨 Strictly use _id to ensure MongoDB understands the query
    const query = { user: { $ne: req.user._id } };
    
    if (req.query.skill) {
      query.skills = { $regex: req.query.skill, $options: 'i' };
    }

    const total = await Profile.countDocuments(query);
    
    // 🚨 THE FIX: Use an object in populate to add the match condition for soft deletes
    const experts = await Profile.find(query)
      .populate({
        path: 'user',
        select: 'name email profileImage isDeleted accountStatus',
        match: { 
          isDeleted: { $ne: true }, 
          accountStatus: { $ne: 'deleted' } 
        }
      })
      .skip(startIndex)
      .limit(limit);

    // 🚨 Because of the match condition above, soft-deleted users become 'null'.
    // This existing filter will now perfectly catch both hard and soft deletes!
    const validExperts = experts.filter(exp => exp.user != null);
   
    res.status(200).json({
      success: true,
      count: validExperts.length,
      pagination: { total, page, pages: Math.ceil(total / limit) },
      data: validExperts
    });
  } catch (error) {
    console.error("❌ ERROR in getExperts:", error);
    next(error);
  }
};

// @desc   Get All Live Experts (Instant Solver Screen)
// @route  GET /api/v1/experts/live
exports.getLiveExperts = async (req, res, next) => {
  try {
    // 🚨 THE GHOST KILLER: Calculate the time exactly 15 minutes ago
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

    const liveExperts = await Profile.find({
      isLive: true,
      liveConnectionStatus: 'available',
      // ONLY show them if their app has pinged us in the last 15 mins
      lastActiveAt: { $gte: fifteenMinutesAgo },
      // Prevent the expert from seeing themselves in the live grid
      user: { $ne: req.user._id } 
    })
    .populate({
      path: 'user',
      select: 'name email profileImage isDeleted accountStatus',
      match: { 
        isDeleted: { $ne: true }, 
        accountStatus: { $ne: 'deleted' } 
      }
    });

    // 🚨 Filter out soft-deleted users (where populated user became null)
    const validLiveExperts = liveExperts.filter(exp => exp.user != null);

    res.status(200).json({ 
      success: true, 
      count: validLiveExperts.length,
      data: validLiveExperts 
    });
  } catch (error) {
    console.error("❌ ERROR in getLiveExperts:", error);
    next(error);
  }
};