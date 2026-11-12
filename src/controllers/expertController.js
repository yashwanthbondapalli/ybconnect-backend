// backend/src/controllers/expertController.js
const Profile = require('../models/Profile');

const escapeRegex = (str) => {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const SENSITIVE_PROFILE_EXCLUSIONS =
  '-accountNumber -ifscCode -razorpayAccountId -phoneNumber -zoomCredentials -mentorApplication';

// Inside backend/src/controllers/expertController.js

exports.getExperts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const currentUserId = req.user ? req.user._id : null;

    // Use native collection query to bypass Mongoose casting errors
    const query = { role: 'expert' };
    if (currentUserId) {
      const { ObjectId } = require('mongoose').Types;
      try {
        query.user = { $ne: new ObjectId(String(currentUserId)) };
      } catch (e) {}
    }

    const rawProfiles = await Profile.collection
      .find(query)
      .skip(skip)
      .limit(limit)
      .toArray();

    // Populate user details manually for safety
    const User = require('../models/User');
    const profiles = await Promise.all(
      rawProfiles.map(async (p) => {
        const u = await User.findById(p.user).select('name email phoneNumber isDeleted').lean();
        return { ...p, user: u };
      })
    );

    res.status(200).json({ success: true, data: profiles });
  } catch (error) {
    console.error('❌ ERROR in getExperts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};

exports.getLiveExperts = async (req, res) => {
  try {
    const currentUserId = req.user ? req.user._id : null;

    const query = { role: 'expert', isLive: true };
    if (currentUserId) {
      const { ObjectId } = require('mongoose').Types;
      try {
        query.user = { $ne: new ObjectId(String(currentUserId)) };
      } catch (e) {}
    }

    const rawProfiles = await Profile.collection.find(query).toArray();

    const User = require('../models/User');
    const profiles = await Promise.all(
      rawProfiles.map(async (p) => {
        const u = await User.findById(p.user).select('name email phoneNumber isDeleted').lean();
        return { ...p, user: u };
      })
    );

    res.status(200).json({ success: true, data: profiles });
  } catch (error) {
    console.error('❌ ERROR in getLiveExperts:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};