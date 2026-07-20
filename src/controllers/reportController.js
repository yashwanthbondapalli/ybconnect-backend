const Report = require('../models/Report');

exports.createReport = async (req, res, next) => {
  try {
    const { 
      reportedUserId, 
      contentId, 
      contentType, 
      reportedContentSnapshot, 
      reasonCategory, 
      userComment 
    } = req.body;
    
    const reporterId = req.user._id || req.user.id;

    // 1. Basic Validation: You can't report yourself
    if (reporterId.toString() === reportedUserId.toString()) {
      return res.status(400).json({ success: false, error: 'You cannot report your own content.' });
    }

    // 2. Anti-Spam Check: Did they already report this exact post?
    const existingReport = await Report.findOne({ reporter: reporterId, contentId });
    if (existingReport) {
      return res.status(400).json({ success: false, error: 'You have already submitted a report for this specific content.' });
    }

    // 3. Save the report securely
    const report = await Report.create({
      reporter: reporterId,
      reportedUser: reportedUserId,
      contentId,
      contentType,
      reportedContentSnapshot,
      reasonCategory,
      userComment
    });

    res.status(201).json({ 
      success: true, 
      message: 'Report submitted successfully. The YBConnect team will review this shortly.' 
    });

  } catch (error) {
    console.error("Report Creation Error:", error);
    res.status(500).json({ success: false, error: 'Failed to submit report. Please try again.' });
  }
};