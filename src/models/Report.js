// backend/src/controllers/reportController.js
const mongoose = require('mongoose');
const Report = require('../models/Report');

exports.createReport = async (req, res) => {
  try {
    const {
      reportedUserId,
      contentId,
      contentType,
      reportedContentSnapshot,
      reasonCategory,
      userComment,
    } = req.body;

    const reporterId = String(req.user._id || req.user.id);

    if (
      !reportedUserId ||
      !mongoose.Types.ObjectId.isValid(reportedUserId) ||
      !contentId
    ) {
      return res.status(400).json({
        success: false,
        error: 'Valid reportedUserId and contentId are required.',
      });
    }

    if (reporterId === String(reportedUserId)) {
      return res.status(400).json({
        success: false,
        error: 'You cannot report your own content.',
      });
    }

    const existingReport = await Report.findOne({
      reporter: reporterId,
      contentId: String(contentId).trim(),
    });
    if (existingReport) {
      return res.status(400).json({
        success: false,
        error: 'You have already submitted a report for this specific content.',
      });
    }

    await Report.create({
      reporter: reporterId,
      reportedUser: reportedUserId,
      contentId: String(contentId).trim().slice(0, 100),
      contentType:
        typeof contentType === 'string' ? contentType.trim().slice(0, 50) : 'post',
      reportedContentSnapshot:
        typeof reportedContentSnapshot === 'string'
          ? reportedContentSnapshot.trim().slice(0, 2000)
          : '',
      reasonCategory:
        typeof reasonCategory === 'string'
          ? reasonCategory.trim().slice(0, 100)
          : 'Other',
      userComment:
        typeof userComment === 'string' ? userComment.trim().slice(0, 1000) : '',
    });

    res.status(201).json({
      success: true,
      message:
        'Report submitted successfully. The YB Connect team will review this shortly.',
    });
  } catch (error) {
    console.error('Report Creation Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit report. Please try again.',
    });
  }
};