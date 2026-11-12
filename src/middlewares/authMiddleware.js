// backend/src/middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    typeof req.headers.authorization === 'string' &&
    req.headers.authorization.startsWith('Bearer ')
  ) {
    token = req.headers.authorization.split(' ')[1]?.trim();
  }

  if (!token || token === 'null' || token === 'undefined') {
    return res.status(401).json({
      success: false,
      error: 'Not authorized. No token provided.',
    });
  }

  try {
    // Enforce HS256 algorithm to block "alg: none" or key-confusion attacks
    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
    });

    const userId = decoded.id || decoded._id;
    if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized. Malformed token payload.',
      });
    }

    const currentUser = await User.findById(String(userId)).select('-password');
    if (!currentUser) {
      return res.status(401).json({
        success: false,
        error: 'The user belonging to this token no longer exists.',
      });
    }

    // Block deleted or suspended accounts immediately
    if (currentUser.isDeleted || currentUser.accountStatus === 'deleted') {
      return res.status(401).json({
        success: false,
        error: 'This account has been deleted.',
      });
    }

    if (currentUser.accountStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Your account has been suspended. Please contact support.',
      });
    }

    // Invalidate tokens issued BEFORE the last password change/reset
    if (currentUser.passwordChangedAt) {
      const changedTimestamp = Math.floor(
        new Date(currentUser.passwordChangedAt).getTime() / 1000
      );
      if (decoded.iat && decoded.iat < changedTimestamp) {
        return res.status(401).json({
          success: false,
          error: 'Password was recently changed. Please log in again.',
        });
      }
    }

    // Ensure both req.user._id and req.user.id are always defined
    currentUser.id = String(currentUser._id);
    req.user = currentUser;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized. Invalid or expired token.',
    });
  }
};

/**
 * Restricts route access strictly to Admin accounts
 */
const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Security Alert: Admin privileges are required to perform this action.',
    });
  }
  next();
};

module.exports = { protect, adminOnly };