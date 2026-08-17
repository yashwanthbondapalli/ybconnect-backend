const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  // 1. Extract the token
if (
  req.headers.authorization &&
  req.headers.authorization.startsWith('Bearer ')
) {
    token = req.headers.authorization.split(' ')[1];
  }

  // 2. Trap missing tokens immediately
  if (!token) {
    return res.status(401).json({ success: false, error: 'Not authorized. No token provided.' });
  }

  try {
    // 🚨 SECURITY PATCH: Enforce HS256 algorithm to prevent "alg: none" forgery attacks
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const userId = decoded.id || decoded._id;

    // 3. Fetch the user
    const currentUser = await User.findById(userId).select('-password');

    // 4. Check if user still exists
    if (!currentUser) {
      return res.status(401).json({ success: false, error: 'The user belonging to this token no longer exists.' });
    }

    // 🚨 SECURITY PATCH: The "Zombie User" Guard
    if (currentUser.isDeleted || currentUser.accountStatus === 'deleted') {
      return res.status(401).json({ success: false, error: 'This account has been deleted.' });
    }

    if (currentUser.accountStatus === 'suspended') {
      return res.status(403).json({ success: false, error: 'Account suspended. Please contact support.' });
    }

    // 5. Check for recent password changes
    if (currentUser.passwordChangedAt) {
      const changedTimestamp = parseInt(currentUser.passwordChangedAt.getTime() / 1000, 10);
      if (decoded.iat < changedTimestamp) {
        return res.status(401).json({ success: false, error: 'Password recently changed. Please log in again.' });
      }
    }

    // 6. Attach verified user to request
    req.user = currentUser;
    next();
    
  } catch (error) {
    console.log("💥 AUTH REJECTED:", error.message);
    return res.status(401).json({ success: false, error: 'Not authorized. Invalid or expired token.' });
  }
};

module.exports = { protect };