// backend/src/controllers/authController.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Profile = require('../models/Profile');
const CallRequest = require('../models/CallRequest');
const OTP = require('../models/OTP');
const DeletedAccount = require('../models/DeletedAccount');
const {
  generateAccessToken,
  generateRefreshToken,
} = require('../utils/generateToken');
const sendEmail = require('../utils/emailHelper');
const generateUniqueSlug = require('../utils/generateSlug');

// --- STRICT INPUT SANITIZERS (Blocks NoSQL Injection & Type Confusion) ---
const sanitizeEmail = (rawEmail) => {
  if (typeof rawEmail !== 'string') return '';
  const clean = rawEmail.toLowerCase().trim();
  if (clean.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
    return '';
  }
  return clean;
};

const sanitizeOtp = (rawOtp) => {
  if (typeof rawOtp !== 'string' && typeof rawOtp !== 'number') return '';
  const clean = String(rawOtp).trim();
  return /^[0-9]{6}$/.test(clean) ? clean : '';
};

const isValidPassword = (rawPassword) => {
  return (
    typeof rawPassword === 'string' &&
    rawPassword.length >= 6 &&
    rawPassword.length <= 128
  );
};

// 1. LOGIN USER
exports.loginUser = async (req, res, next) => {
  try {
    const email = sanitizeEmail(req.body?.email);
    const password = req.body?.password;

    if (!email || typeof password !== 'string' || !password) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email and password.',
      });
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({
        success: false,
        error: 'Invalid email or password.',
      });
    }

    if (user.isDeleted || user.accountStatus === 'deleted') {
      return res.status(401).json({
        success: false,
        error: 'This account has been deleted.',
      });
    }

    if (user.accountStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Your account has been suspended. Please contact support.',
      });
    }

    res.status(200).json({
      success: true,
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      accessToken: generateAccessToken(user._id),
      refreshToken: generateRefreshToken(user._id),
    });
  } catch (error) {
    next(error);
  }
};

// 2. REFRESH ACCESS TOKEN
exports.refreshToken = async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(401).json({
        success: false,
        error: 'Refresh token is required.',
      });
    }

    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET, {
      algorithms: ['HS256'],
    });

    const userId = decoded.id || decoded._id;
    const user = await User.findById(userId).select('-password');

    if (!user || user.isDeleted || user.accountStatus === 'deleted') {
      return res.status(401).json({
        success: false,
        error: 'User account is no longer active.',
      });
    }

    if (user.accountStatus === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Account suspended.',
      });
    }

    // Revoke refresh tokens issued BEFORE a password change or reset
    if (user.passwordChangedAt) {
      const changedTimestamp = Math.floor(
        user.passwordChangedAt.getTime() / 1000
      );
      if (decoded.iat && decoded.iat < changedTimestamp) {
        return res.status(401).json({
          success: false,
          error: 'Password was recently changed. Please log in again.',
        });
      }
    }

    return res.status(200).json({
      success: true,
      accessToken: generateAccessToken(user._id),
    });
  } catch (error) {
    return res.status(403).json({
      success: false,
      error: 'Invalid or expired session. Please log in again.',
    });
  }
};

// 3. UPDATE EXPO PUSH TOKEN (Prevents Cross-Account Token Collision)
exports.updatePushToken = async (req, res, next) => {
  try {
    const token =
      typeof req.body?.token === 'string' ? req.body.token.trim() : '';

    if (token && !token.startsWith('ExponentPushToken')) {
      return res.status(400).json({
        success: false,
        error: 'Invalid push token format.',
      });
    }

    if (token) {
      // Detach this device's push token from any previous user account on the same phone
      await User.updateMany(
        { expoPushToken: token, _id: { $ne: req.user.id } },
        { $set: { expoPushToken: null } }
      );
    }

    await User.findByIdAndUpdate(req.user.id, {
      expoPushToken: token || null,
    });

    res.status(200).json({ success: true, message: 'Push token updated' });
  } catch (error) {
    next(error);
  }
};

// 4. UPDATE USER NAME
exports.updateProfile = async (req, res, next) => {
  try {
    const cleanName =
      typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!cleanName || cleanName.length > 80) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid name (up to 80 characters).',
      });
    }

    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { name: cleanName },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      data: {
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 5. UPDATE PASSWORD (AUTHENTICATED)
exports.updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (typeof currentPassword !== 'string' || !currentPassword) {
      return res.status(400).json({
        success: false,
        error: 'Please enter your current password.',
      });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        error: 'New password must be between 6 and 128 characters long.',
      });
    }

    const user = await User.findById(req.user.id).select('+password');
    if (!user || !(await user.matchPassword(currentPassword))) {
      return res.status(401).json({
        success: false,
        error: 'Incorrect current password.',
      });
    }

    user.password = newPassword;
    await user.save(); // UserSchema pre('save') hashes password & updates passwordChangedAt

    res.status(200).json({
      success: true,
      accessToken: generateAccessToken(user._id),
      refreshToken: generateRefreshToken(user._id),
      message: 'Password updated successfully.',
    });
  } catch (error) {
    next(error);
  }
};

// 6. GET CURRENT LOGGED-IN USER
exports.getMe = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        _id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
      },
    });
  } catch (error) {
    next(error);
  }
};

// 7. SEND REGISTRATION / EMAIL CHANGE OTP
exports.sendEmailOtp = async (req, res, next) => {
  try {
    const email = sanitizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email address.',
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'This email is already registered.',
      });
    }

    const otp = crypto.randomInt(100000, 999999).toString();

    await OTP.deleteMany({ email });
    await OTP.create({ email, otp });

    await sendEmail({
      email,
      subject: 'YB Connect - Verify your Email',
      message: `Your YB Connect verification code is: ${otp}\n\nThis code expires in 10 minutes. Do not share this code with anyone.`,
    });

    res.status(200).json({ success: true, message: 'OTP sent successfully.' });
  } catch (error) {
    next(error);
  }
};

// 8. REGISTER NEW USER
exports.registerUser = async (req, res, next) => {
  try {
    const name =
      typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = sanitizeEmail(req.body?.email);
    const password = req.body?.password;
    const phoneNumber =
      typeof req.body?.phoneNumber === 'string'
        ? req.body.phoneNumber.trim()
        : '';
    const otp = sanitizeOtp(req.body?.otp);

    if (!name || !email || !password || !phoneNumber || !otp) {
      return res.status(400).json({
        success: false,
        error: 'All fields and a valid 6-digit OTP are required.',
      });
    }

    if (name.length > 80) {
      return res.status(400).json({
        success: false,
        error: 'Name cannot exceed 80 characters.',
      });
    }

    if (!isValidPassword(password)) {
      return res.status(400).json({
        success: false,
        error: 'Password must be between 6 and 128 characters long.',
      });
    }

    if (!/^[0-9]{10}$/.test(phoneNumber)) {
      return res.status(400).json({
        success: false,
        error: 'Phone number must be exactly 10 digits.',
      });
    }

    // Strict string-only query (immune to NoSQL operator injection)
   const validOtp = await OTP.verifyAndConsume(email, otp);
    if (!validOtp) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired OTP.',
      });
    }

    const userExists = await User.findOne({
      $or: [{ email }, { phoneNumber }],
    });
    if (userExists) {
      if (userExists.email === email) {
        return res.status(400).json({
          success: false,
          error: 'Email is already registered.',
        });
      }
      return res.status(400).json({
        success: false,
        error: 'Phone number is already registered.',
      });
    }

    const uniqueSlug = await generateUniqueSlug(name);

    // Explicitly set role: 'user' so nobody can self-register as 'admin'
    const user = await User.create({
      name,
      email,
      phoneNumber,
      password,
      role: 'user',
      slug: uniqueSlug,
    });

    await OTP.deleteMany({ email });

    res.status(201).json({
      success: true,
      _id: user._id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
      role: user.role,
      slug: user.slug,
      accessToken: generateAccessToken(user._id),
      refreshToken: generateRefreshToken(user._id),
    });
  } catch (error) {
    next(error);
  }
};

// 9. UPDATE USER EMAIL (WITH OTP VERIFICATION)
exports.updateUserEmail = async (req, res) => {
  try {
    const newEmail = sanitizeEmail(req.body?.newEmail);
    const otp = sanitizeOtp(req.body?.otp);
    const userId = req.user.id;

    if (!newEmail || !otp) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid new email and 6-digit OTP.',
      });
    }

    const emailExists = await User.findOne({ email: newEmail });
    if (emailExists) {
      return res.status(400).json({
        success: false,
        error: 'This email is already registered to another account.',
      });
    }

    const validOtp = await OTP.findOne({ email: newEmail, otp });
    if (!validOtp) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired OTP.',
      });
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { email: newEmail },
      { new: true, runValidators: true }
    ).select('-password');

    await OTP.deleteMany({ email: newEmail });

    res.status(200).json({ success: true, data: updatedUser });
  } catch (error) {
    console.error('Update Email Error:', error);
    res.status(500).json({ success: false, error: 'Failed to update email.' });
  }
};

// 10. SEND PASSWORD RESET OTP
exports.sendPasswordResetOtp = async (req, res) => {
  try {
    const email = sanitizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email address.',
      });
    }

    const userExists = await User.findOne({ email });
    if (!userExists || userExists.isDeleted) {
      return res.status(404).json({
        success: false,
        error: 'No active account found with this email.',
      });
    }

    const generatedOtp = crypto.randomInt(100000, 999999).toString();

    // Wipe any previous reset OTPs for this email so old codes cannot be used
    await OTP.deleteMany({ email });
    await OTP.create({
      email,
      otp: generatedOtp,
      createdAt: Date.now(),
    });

    await sendEmail({
      email,
      subject: 'YB Connect - Password Reset Code',
      message: `Your password reset OTP is: ${generatedOtp}\n\nThis code expires in 10 minutes. If you did not request this, please ignore this email.`,
    });

    res.status(200).json({
      success: true,
      message: 'Password reset OTP sent successfully.',
    });
  } catch (error) {
    console.error('Reset OTP Error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send reset OTP.',
    });
  }
};

// 11. RESET PASSWORD WITH OTP
exports.resetPasswordWithOtp = async (req, res) => {
  try {
    const email = sanitizeEmail(req.body?.email);
    const otp = sanitizeOtp(req.body?.otp);
    const newPassword = req.body?.newPassword;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid email, 6-digit OTP, and new password.',
      });
    }

    if (!isValidPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        error: 'Password must be between 6 and 128 characters long.',
      });
    }

    // Strict string-only query (immune to NoSQL operator injection)
   const validOtp = await OTP.verifyAndConsume(email, otp);
    if (!validOtp) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired OTP.',
      });
    }

    const user = await User.findOne({ email });
    if (!user || user.isDeleted) {
      return res.status(404).json({
        success: false,
        error: 'User not found.',
      });
    }

    user.password = newPassword;
    // UserSchema.pre('save') hashes the new password AND updates passwordChangedAt,
    // which immediately revokes all existing access & refresh tokens!
    await user.save();

    await OTP.deleteMany({ email });

    res.status(200).json({
      success: true,
      message: 'Password has been securely reset. Please log in with your new password.',
    });
  } catch (error) {
    console.error('OTP Reset Error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while resetting password.',
    });
  }
};

// 12. DELETE ACCOUNT (Protected Against Leaving Active Paid Escrow Sessions Hanging)
exports.deleteAccount = async (req, res, next) => {
  try {
    const reason =
      typeof req.body?.reason === 'string'
        ? req.body.reason.trim().slice(0, 500)
        : 'No reason provided';

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Safety Check: Prevent deleting an account while a paid upcoming session is still pending completion
    const activePaidSession = await CallRequest.findOne({
      $or: [{ requester: req.user.id }, { recipient: req.user.id }],
      status: 'accepted',
      paymentStatus: 'paid',
    });

    if (activePaidSession) {
      return res.status(400).json({
        success: false,
        error:
          'You have an active paid session scheduled. Please complete or cancel your upcoming session (and withdraw any wallet balance) before deleting your account.',
      });
    }

    await DeletedAccount.create({
      originalUserId: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      reasonForLeaving: reason,
    });

    // Cancel any unpaid pending requests involving this user
    await CallRequest.updateMany(
      {
        $or: [{ requester: req.user.id }, { recipient: req.user.id }],
        status: { $in: ['pending', 'holding', 'offer_made'] },
        paymentStatus: 'pending',
      },
      {
        $set: {
          status: 'cancelled',
          cancelReason: 'User account deleted',
        },
      }
    );

    await Profile.findOneAndDelete({ user: req.user.id });
    await User.findByIdAndDelete(req.user.id);

    res.status(200).json({
      success: true,
      message: 'Account deleted and feedback logged.',
    });
  } catch (error) {
    next(error);
  }
};