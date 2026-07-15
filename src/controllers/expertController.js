const Profile = require('../models/Profile');

exports.getExperts = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    
    // 🚨 SECURITY FIX: Hard cap the limit to a maximum of 50 per request to prevent DoS attacks
    let requestedLimit = parseInt(req.query.limit, 10) || 20;
    const limit = Math.min(requestedLimit, 50); 
    
    const startIndex = (page - 1) * limit;

    const query = { user: { $ne: req.user._id } };
    
    if (req.query.skill) {
      query.skills = { $regex: req.query.skill, $options: 'i' };
    }

    const total = await Profile.countDocuments(query);
    
    const experts = await Profile.find(query)
      .populate({
        path: 'user',
        // 🚨 SECURITY FIX: Removed 'email' to prevent massive data leakage
        select: 'name profileImage isDeleted accountStatus',
        match: { 
          isDeleted: { $ne: true }, 
          accountStatus: { $ne: 'deleted' } 
        }
      })
      .skip(startIndex)
      .limit(limit);

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
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);

    const liveExperts = await Profile.find({
      isLive: true,
      liveConnectionStatus: 'available',
      lastActiveAt: { $gte: fifteenMinutesAgo },
      user: { $ne: req.user._id } 
    })
    .populate({
      path: 'user',
      // 🚨 SECURITY FIX: Removed 'email' to prevent massive data leakage
      select: 'name profileImage isDeleted accountStatus',
      match: { 
        isDeleted: { $ne: true }, 
        accountStatus: { $ne: 'deleted' } 
      }
    });

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