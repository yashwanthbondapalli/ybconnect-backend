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
    

    const experts = await Profile.find(query)
      .populate('user', 'name email')
      .skip(startIndex)
      .limit(limit);

    // 🚨 Clean up dummy data: Filter out profiles where the User was deleted from the DB
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