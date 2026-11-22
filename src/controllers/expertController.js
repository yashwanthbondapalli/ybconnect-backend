// backend/src/controllers/expertController.js
const mongoose = require('mongoose');
const Profile = require('../models/Profile');
const User = require('../models/User');

// Strictly exclude sensitive/private fields at the MongoDB projection level
const PUBLIC_PROFILE_PROJECTION = {
  accountNumber: 0,
  ifscCode: 0,
  razorpayAccountId: 0,
  phoneNumber: 0,
  zoomCredentials: 0,
  mentorApplication: 0,
};

// Matches the 90-second frontend heartbeat: force-killed apps auto-expire within 3 minutes
const LIVE_WINDOW_MS = 3 * 60 * 1000;

const attachPublicUsers = async (rawProfiles) => {
  if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) return [];

  const userIds = rawProfiles.map((p) => p.user).filter(Boolean);
  const activeUsers = await User.collection
    .find(
      {
        _id: { $in: userIds },
        isDeleted: { $ne: true },
        accountStatus: { $nin: ['deleted', 'suspended'] },
      },
      {
        projection: { _id: 1, name: 1, slug: 1, isDeleted: 1 },
      }
    )
    .toArray();

  const userMap = new Map(activeUsers.map((u) => [String(u._id), u]));

const nowMs = Date.now();

  return rawProfiles
    .map((p) => {
      const lastActiveMs = p.lastActiveAt ? new Date(p.lastActiveAt).getTime() : 0;
      const isActuallyLive = Boolean(
        p.isLive && lastActiveMs > 0 && nowMs - lastActiveMs <= LIVE_WINDOW_MS
      );

      return {
        ...p,
        isLive: isActuallyLive,
        liveConnectionStatus: isActuallyLive
          ? p.liveConnectionStatus || 'available'
          : 'offline',
        user: userMap.get(String(p.user)) || null,
      };
    })
    .filter((p) => p.user !== null);
};

exports.getExperts = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const skip = (page - 1) * limit;

    const currentUserId = req.user ? req.user._id || req.user.id : null;
    const query = { role: 'expert' };

    if (currentUserId && mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      query.user = { $ne: new mongoose.Types.ObjectId(String(currentUserId)) };
    }

    // Fetch limit + 1 so we know accurately whether more pages exist
    const rawProfiles = await Profile.collection
      .find(query, { projection: PUBLIC_PROFILE_PROJECTION })
      .sort({ isLive: -1, lastActiveAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)
      .toArray();

    const hasMore = rawProfiles.length > limit;
    const pageSlice = hasMore ? rawProfiles.slice(0, limit) : rawProfiles;
    const profiles = await attachPublicUsers(pageSlice);

    res.status(200).json({
      success: true,
      hasMore,
      page,
      data: profiles,
    });
  } catch (error) {
    console.error('❌ ERROR in getExperts:', error);
    res.status(500).json({ success: false, error: 'Failed to load mentors.' });
  }
};

exports.getLiveExperts = async (req, res) => {
  try {
    const currentUserId = req.user ? req.user._id || req.user.id : null;
    const cutoffDate = new Date(Date.now() - LIVE_WINDOW_MS);

    const query = {
      role: 'expert',
      isLive: true,
      lastActiveAt: { $gte: cutoffDate },
    };

    if (currentUserId && mongoose.Types.ObjectId.isValid(String(currentUserId))) {
      query.user = { $ne: new mongoose.Types.ObjectId(String(currentUserId)) };
    }

    const rawProfiles = await Profile.collection
      .find(query, { projection: PUBLIC_PROFILE_PROJECTION })
      .sort({ lastActiveAt: -1 })
      .limit(60)
      .toArray();

    const profiles = await attachPublicUsers(rawProfiles);

    res.status(200).json({ success: true, data: profiles });
  } catch (error) {
    console.error('❌ ERROR in getLiveExperts:', error);
    res.status(500).json({ success: false, error: 'Failed to load live mentors.' });
  }
};