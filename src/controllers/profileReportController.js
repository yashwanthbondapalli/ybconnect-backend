// backend/src/controllers/profileReportController.js
const mongoose = require('mongoose');
const ProfileReport = require('../models/ProfileReport');

exports.createProfileReport = async (req, res) => {
  try {
    const { reportedUserId, reason, description } = req.body;
    const reporterId = String(req.user._id || req.user.id);

    if (
      !reportedUserId ||
      !mongoose.Types.ObjectId.isValid(reportedUserId) ||
      typeof reason !== 'string' ||
      !reason.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: 'Valid User ID and reason are required.',
      });
    }

    if (String(reportedUserId) === reporterId) {
      return res.status(400).json({
        success: false,
        error: 'You cannot report your own profile.',
      });
    }

    const existingReport = await ProfileReport.findOne({
      reportedUser: reportedUserId,
      reportedBy: reporterId,
    });

    if (existingReport) {
      return res.status(400).json({
        success: false,
        error: 'You have already submitted a report for this profile.',
      });
    }

    const report = await ProfileReport.create({
      reportedUser: reportedUserId,
      reportedBy: reporterId,
      reason: reason.trim().slice(0, 150),
      description:
        typeof description === 'string' ? description.trim().slice(0, 1000) : '',
    });

    res.status(201).json({ success: true, data: report });
  } catch (error) {
    console.error('Profile Report Creation Error:', error);
    res.status(500).json({ success: false, error: 'Failed to submit report.' });
  }
};