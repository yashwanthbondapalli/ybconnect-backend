const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  // 1. Extract the token from the Authorization header
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  // 2. Trap missing tokens immediately
  if (!token) {
    console.log(`⛔ 401 FAILED: The mobile app did not send a token for ${req.originalUrl}`);
    return res.status(401).json({ 
      success: false, 
      error: 'Not authorized to access this route. No token provided.' 
    });
  }

  try {
    //console.log("🔑 AUTH MIDDLEWARE: Verifying incoming token...");

    // 3. Check if your Render environment variables are properly loaded
    if (!process.env.JWT_SECRET) {
      console.log("🚨 WARNING: process.env.JWT_SECRET is UNDEFINED on Render! Check your Render Environment Dashboard.");
    }

    // 4. Verify the token signature and extract the payload
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
   // console.log("🔍 AUTH MIDDLEWARE: Token decoded successfully:", JSON.stringify(decoded));

    // 5. Handle structural variations (support both decoded.id and decoded._id)
    const userId = decoded.id || decoded._id;
   // console.log("👤 AUTH MIDDLEWARE: Looking up user in MongoDB with ID:", userId);

    // 6. Fetch the user belonging to this token (excluding their password field)
    const currentUser = await User.findById(userId).select('-password');

    // 7. Check if the user still exists in the database
    if (!currentUser) {
      console.log("❌ AUTH MIDDLEWARE: User lookup returned NULL from database!");
      return res.status(401).json({ 
        success: false, 
        error: 'The user belonging to this token no longer exists.' 
      });
    }

    // 8. Check if the user changed passwords after the token was issued
    if (currentUser.passwordChangedAt) {
      const changedTimestamp = parseInt(currentUser.passwordChangedAt.getTime() / 1000, 10);
      if (decoded.iat < changedTimestamp) {
        console.log("❌ AUTH MIDDLEWARE: Password was recently changed. Rejecting token.");
        return res.status(401).json({ 
          success: false, 
          error: 'Password recently changed. Please log in again.' 
        });
      }
    }

    // 9. Attach the verified user to the request object and pass control to the controller
    //console.log("✅ AUTH MIDDLEWARE: User successfully authorized:", currentUser.email);
    req.user = currentUser;
    next();
    
  } catch (error) {
    // 🚨 THIS WILL CATCH AND LOG EXACTLY WHY THE TOKEN IS REJECTED (e.g. "jwt expired" or "invalid signature")
    console.log("💥 AUTH MIDDLEWARE CRASHED WITH ERROR:", error.message);
    
    return res.status(401).json({ 
      success: false, 
      error: 'Not authorized to access this route. Invalid or expired token.' 
    });
  }
};

module.exports = { protect };
