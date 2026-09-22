const ProfileReport = require('../models/ProfileReport');

exports.createProfileReport = async (req, res, next) => {
  try {
    const { reportedUserId, reason, description } = req.body;

    if (!reportedUserId || !reason) {
      return res.status(400).json({ success: false, error: 'User ID and reason are required.' });
    }

    if (reportedUserId === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot report your own profile.' });
    }

    const report = await ProfileReport.create({
      reportedUser: reportedUserId,
      reportedBy: req.user.id,
      reason,
      description
    });

    res.status(201).json({ success: true, data: report });
  } catch (error) {
    console.error("Profile Report Creation Error:", error);
    res.status(500).json({ success: false, error: 'Failed to submit report.' });
  }
};