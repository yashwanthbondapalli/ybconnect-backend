const User = require('../models/User');
// 🚨 SECURITY UPGRADE: Importing both token generators
const { generateAccessToken, generateRefreshToken } = require('../utils/generateToken');
const OTP = require('../models/OTP');
const sendEmail = require('../utils/emailHelper');
const crypto = require('crypto');
const generateUniqueSlug = require('../utils/generateSlug');
const Profile = require('../models/Profile');
const jwt = require('jsonwebtoken'); // Needed for the refresh route

exports.loginUser = async (req, res, next) => {
  try {
    let { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Please provide email and password' });
    }

    email = email.toLowerCase().trim();

    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // 🚨 SECURITY UPGRADE: Issuing both tokens
    res.status(200).json({
      success: true,
      _id: user._id,
      name: user.name,
      email: user.email,
      accessToken: generateAccessToken(user._id),
      refreshToken: generateRefreshToken(user._id),
    });
  } catch (error) {
    next(error);
  }
};

// 🚨 NEW ENDPOINT: Refresh Token Logic
exports.refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    
    if (!refreshToken) {
      return res.status(401).json({ success: false, error: 'Refresh token required' });
    }

    // Verify the long-lived refresh token
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    
    const user = await User.findById(decoded.id || decoded._id);
    if (!user) {
      return res.status(401).json({ success: false, error: 'User no longer exists' });
    }

    // Issue a fresh 15-minute Access Token
    res.status(200).json({
      success: true,
      accessToken: generateAccessToken(user._id)
    });

  } catch (error) {
    return res.status(403).json({ success: false, error: 'Invalid or expired refresh token. Please log in again.' });
  }
};

exports.updatePushToken = async (req, res, next) => {
  try {
    const { token } = req.body;
    await User.findByIdAndUpdate(req.user.id, { expoPushToken: token });
    res.status(200).json({ success: true, message: 'Push token updated' });
  } catch (error) {
    next(error);
  }
};

exports.updateProfile = async (req, res, next) => {
  try {
    const { name } = req.body;
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      { name },
      { new: true, runValidators: true }
    );

    res.status(200).json({
      success: true,
      data: {
        _id: updatedUser._id,
        name: updatedUser.name,
        email: updatedUser.email,
        role: updatedUser.role
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // 🚨 SECURITY UPGRADE: Server-side validation
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters long.' });
    }

    const user = await User.findById(req.user.id).select('+password');

    if (!(await user.matchPassword(currentPassword))) {
      return res.status(401).json({ success: false, error: 'Incorrect current password' });
    }

    user.password = newPassword;
    user.passwordChangedAt = Date.now() - 1000;
    await user.save();

    // 🚨 SECURITY UPGRADE: Re-issue both tokens so user stays logged in
    res.status(200).json({
      success: true,
      accessToken: generateAccessToken(user._id),
      refreshToken: generateRefreshToken(user._id),
      message: 'Password updated successfully'
    });
  } catch (error) {
    next(error);
  }
};

exports.getMe = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        _id: req.user._id,
        name: req.user.name,
        email: req.user.email,
      }
    });
  } catch (error) {
    next(error);
  }
};

exports.sendEmailOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ success: false, error: 'Email is already registered' });

    // Cryptographically secure OTP
    const otp = crypto.randomInt(100000, 999999).toString();

    await OTP.deleteMany({ email });
    await OTP.create({ email, otp });

    await sendEmail({
      email: email,
      subject: 'YB Connect - Verify your Email',
      message: `Your registration OTP is: ${otp}\n\nThis code expires in 10 minutes.`
    });

    res.status(200).json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    next(error);
  }
};

exports.registerUser = async (req, res, next) => {
  try {
    let { name, email, password, phoneNumber, otp } = req.body;

    // 🚨 SECURITY UPGRADE: Strict Backend Validation Armor
    if (!name || !email || !password || !phoneNumber || !otp) {
      return res.status(400).json({ success: false, error: 'All fields are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
    }
    const phoneRegex = /^[0-9]{10}$/;
    if (!phoneRegex.test(phoneNumber)) {
      return res.status(400).json({ success: false, error: 'Phone number must be exactly 10 digits.' });
    }

    if (email) email = email.toLowerCase().trim();

    const validOtp = await OTP.findOne({ email, otp });
    if (!validOtp) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
    }

    const userExists = await User.findOne({ $or: [{ email }, { phoneNumber }] });
    if (userExists) {
      if (userExists.email === email) {
        return res.status(400).json({ success: false, error: 'Email is already registered.' });
      }
      return res.status(400).json({ success: false, error: 'Phone number is already registered.' });
    }

    const uniqueSlug = await generateUniqueSlug(name);

    const user = await User.create({ 
      name, 
      email, 
      phoneNumber, 
      password,
      slug: uniqueSlug 
    });

    await OTP.deleteMany({ email });

    // 🚨 SECURITY UPGRADE: Issuing both tokens on register
    res.status(201).json({
      success: true,
      _id: user._id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber, 
      slug: user.slug, 
      accessToken: generateAccessToken(user._id),
      refreshToken: generateRefreshToken(user._id),
    });

  } catch (error) {
    next(error);
  }
};

exports.updateUserEmail = async (req, res) => {
  try {
    const { newEmail, otp } = req.body;
    const userId = req.user.id; 

    const emailExists = await User.findOne({ email: newEmail });
    if (emailExists) {
      return res.status(400).json({ success: false, error: 'This email is already registered to another account.' });
    }

    const validOtp = await OTP.findOne({ email: newEmail, otp: otp });
    if (!validOtp) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { email: newEmail },
      { new: true } 
    ).select('-password'); 

    await OTP.deleteOne({ _id: validOtp._id });

    res.status(200).json({ success: true, data: updatedUser });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Failed to update email.' });
  }
};

exports.sendPasswordResetOtp = async (req, res) => {
  try {
    const { email } = req.body;

    const userExists = await User.findOne({ email: email.toLowerCase() });
    if (!userExists) {
      return res.status(404).json({ success: false, error: 'No account found with this email.' });
    }

    // 🚨 SECURITY UPGRADE: Replaced Math.random with cryptographically secure generator
    const generatedOtp = crypto.randomInt(100000, 999999).toString();

    await OTP.create({
      email: email.toLowerCase(),
      otp: generatedOtp,
      createdAt: Date.now()
    });

    await sendEmail({
      email: email.toLowerCase(),
      subject: 'YB Connect - Password Reset Code',
      message: `Your password reset OTP is: ${generatedOtp}\n\nThis code expires in 10 minutes. If you did not request this, please ignore this email.`
    });

    res.status(200).json({ success: true, message: 'Password reset OTP sent successfully.' });

  } catch (error) {
    console.error("Reset OTP Error:", error);
    res.status(500).json({ success: false, error: 'Failed to send reset OTP.' });
  }
};

exports.resetPasswordWithOtp = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, error: 'Please provide all required fields.' });
    }

    // 🚨 SECURITY UPGRADE: Server-side password validation
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
    }

    const validOtp = await OTP.findOne({ email: email.toLowerCase(), otp: otp });
    if (!validOtp) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    user.password = newPassword;
    await user.save();

    await OTP.deleteOne({ _id: validOtp._id });

    res.status(200).json({ success: true, message: 'Password has been securely reset.' });

  } catch (error) {
    console.error("OTP Reset Error:", error);
    res.status(500).json({ success: false, error: 'Server error while resetting password.' });
  }
};

exports.deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const randomSuffix = crypto.randomBytes(4).toString('hex');

    user.name = "Deleted User";
    user.email = `deleted_${userId}_${randomSuffix}@ybconnect.in`;
    user.phoneNumber = `deleted_${userId}_${randomSuffix}`;
    user.slug = `deleted_${userId}_${randomSuffix}`;
    user.expoPushToken = undefined;
    
    user.password = crypto.randomBytes(20).toString('hex');
    user.isDeleted = true;
    user.deletedAt = Date.now();
    user.accountStatus = 'deleted';

    await user.save();

    await Profile.findOneAndUpdate(
      { user: userId },
      {
        $set: {
          phoneNumber: '',
          category: '',
          city: '',
          companyName: '',
          designation: '',
          bio: '',
          skills: [],
          languages: [],
          experience: '',
          achievements: '',
          profileImage: 'default-avatar.png',
          socialLinks: { linkedin: '', instagram: '', xUrl: '', website: '' },
          zoomCredentials: { accessToken: '', refreshToken: '', accountId: '', isConnected: false }
        }
      }
    );

    res.status(200).json({ success: true, message: 'Account securely deleted and anonymized.' });

  } catch (error) {
    console.error("Delete Account Error:", error);
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
};