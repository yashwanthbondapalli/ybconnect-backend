const User = require('../models/User');
const generateToken = require('../utils/generateToken');
const OTP = require('../models/OTP');
const sendEmail = require('../utils/emailHelper');
const crypto = require('crypto');
const generateUniqueSlug = require('../utils/generateSlug');
const Profile = require('../models/Profile');

exports.loginUser = async (req, res, next) => {
  try {
    let { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Please provide email and password' });
    }

    // Sanitize input before querying the database
    email = email.toLowerCase().trim();

    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.matchPassword(password))) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    res.status(200).json({
      success: true,
      _id: user._id,
      name: user.name,
      email: user.email,
      token: generateToken(user._id),
    });
  } catch (error) {
    next(error);
  }
};

// Save Expo Push Token for the logged-in user
exports.updatePushToken = async (req, res, next) => {
  try {
    const { token } = req.body;
    
    // Find the user and update their token
    await User.findByIdAndUpdate(req.user.id, { expoPushToken: token });
    
    res.status(200).json({ success: true, message: 'Push token updated' });
  } catch (error) {
    next(error);
  }
};



// @desc    Update user profile (Name/Username)
// @route   PUT /api/v1/auth/update-profile
exports.updateProfile = async (req, res, next) => {
  try {
    const { name } = req.body;
    
    // We use findByIdAndUpdate to quickly swap the name
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

// @desc    Update user password
// @route   PUT /api/v1/auth/update-password
exports.updatePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // 1. We MUST explicitly select the password field because it's hidden by default
    const user = await User.findById(req.user.id).select('+password');

    // 2. Check if the current password they typed matches the database
    if (!(await user.matchPassword(currentPassword))) {
      return res.status(401).json({ success: false, error: 'Incorrect current password' });
    }

    // 3. Set the new password and SAVE (this triggers the bcrypt hashing in User.js)
    user.password = newPassword;
    user.passwordChangedAt = Date.now() - 1000;
    await user.save();

    // 4. Send back a fresh token so they don't get logged out
    res.status(200).json({
      success: true,
      token: generateToken(user._id),
      message: 'Password updated successfully'
    });
  } catch (error) {
    next(error);
  }
};




// @desc    Get current logged in user (Silent Boot Validation)
// @route   GET /api/v1/auth/me
exports.getMe = async (req, res, next) => {
  try {
    // req.user is attached by the 'protect' middleware
    res.status(200).json({
      success: true,
      data: {
        _id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        // Add any other user details you want globally available on boot
      }
    });
  } catch (error) {
    next(error);
  }
};



// 1. NEW ROUTE: Send OTP to Email
exports.sendEmailOtp = async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    // Ensure email isn't already registered
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ success: false, error: 'Email is already registered' });

// Inside sendEmailOtp:
const otp = crypto.randomInt(100000, 999999).toString();

    // Clear any old OTPs for this email, then save the new one
    await OTP.deleteMany({ email });
    await OTP.create({ email, otp });

    // Send the Email
    await sendEmail({
      email: email,
      subject: '🔐 BacktoBase - Verify your Email',
      message: `Your registration OTP is: ${otp}\n\nThis code expires in 10 minutes.`
    });

    res.status(200).json({ success: true, message: 'OTP sent successfully' });
  } catch (error) {
    next(error);
  }
};

exports.registerUser = async (req, res, next) => {
  try {
    // 1. Extract variables from request
    let { name, email, password, phoneNumber, otp } = req.body;

    // 2. Sanitize input: force lowercase and remove spaces
    if (email) email = email.toLowerCase().trim();

    // 3. Verify the OTP First!
    const validOtp = await OTP.findOne({ email, otp });
    if (!validOtp) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
    }

    // 4. Check if user already exists
    const userExists = await User.findOne({ $or: [{ email }, { phoneNumber }] });
    if (userExists) {
      if (userExists.email === email) {
        return res.status(400).json({ success: false, error: 'Email is already registered.' });
      }
      return res.status(400).json({ success: false, error: 'Phone number is already registered.' });
    }

    // 5. Generate their unique link (slug)
    const uniqueSlug = await generateUniqueSlug(name);

    // 6. Create the User (This combines your old User.create with the new slug)
    const user = await User.create({ 
      name, 
      email, 
      phoneNumber, 
      password,
      slug: uniqueSlug // 🚨 Saving the slug to the database here!
    });

    // 7. Clean up the OTP vault so it can't be used again
    await OTP.deleteMany({ email });

    // 8. Generate Token and send success response
    res.status(201).json({
      success: true,
      _id: user._id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber, 
      slug: user.slug, // Sending the slug back to the frontend
      token: generateToken(user._id), 
    });

  } catch (error) {
    // 🚨 Only ONE catch block at the very end of the function!
    next(error);
  }
};


exports.updateUserEmail = async (req, res) => {
  try {
    const { newEmail, otp } = req.body;
    const userId = req.user.id; // From your JWT auth middleware

    // 1. Check if the new email is already taken by another user
    const emailExists = await User.findOne({ email: newEmail });
    if (emailExists) {
      return res.status(400).json({ success: false, error: 'This email is already registered to another account.' });
    }

    // 2. Verify the OTP
    const validOtp = await OTP.findOne({ email: newEmail, otp: otp });
    if (!validOtp) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
    }

    // 3. Update the User's Email
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { email: newEmail },
      { new: true } // Returns the updated document
    ).select('-password'); // Don't send password back

    // 4. Delete the OTP so it can't be used again
    await OTP.deleteOne({ _id: validOtp._id });

    res.status(200).json({ success: true, data: updatedUser });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Failed to update email.' });
  }
};

exports.resetPasswordWithOtp = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    // 1. Validate inputs
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, error: 'Please provide all required fields.' });
    }

    // 2. Verify the OTP in the database
    const validOtp = await OTP.findOne({ email: email.toLowerCase(), otp: otp });
    if (!validOtp) {
      return res.status(400).json({ success: false, error: 'Invalid or expired OTP.' });
    }

    // 3. Find the User
    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    // 4. Securely update the password
    // (Assuming your User model has a pre('save') hook that automatically encrypts passwords using bcrypt)
    user.password = newPassword;
    await user.save();

    // 5. Burn the OTP so it can never be used by a hacker again
    await OTP.deleteOne({ _id: validOtp._id });

    res.status(200).json({ 
      success: true, 
      message: 'Password has been securely reset.' 
    });

  } catch (error) {
    console.error("OTP Reset Error:", error);
    res.status(500).json({ success: false, error: 'Server error while resetting password.' });
  }
};

// Add this to your authController.js
// Add this to your authController.js
exports.sendPasswordResetOtp = async (req, res) => {
  try {
    const { email } = req.body;

    // 1. MUST EXIST: Check if user actually exists in the database
    const userExists = await User.findOne({ email: email.toLowerCase() });
    if (!userExists) {
      return res.status(404).json({ 
        success: false, 
        error: 'No account found with this email.' 
      });
    }

    // 2. Generate a 6-digit OTP
    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();

    // 3. Save OTP to database
    await OTP.create({
      email: email.toLowerCase(),
      otp: generatedOtp,
      createdAt: Date.now()
    });

    // 4. Send the Email! 
    // 🚨 FIX: Changed ${otp} to ${generatedOtp} and updated the message text
    await sendEmail({
      email: email.toLowerCase(),
      subject: '🔐 YB Connect - Password Reset Code',
      message: `Your password reset OTP is: ${generatedOtp}\n\nThis code expires in 10 minutes. If you did not request this, please ignore this email.`
    });

    res.status(200).json({ 
      success: true, 
      message: 'Password reset OTP sent successfully.' 
    });

  } catch (error) {
    console.error("Reset OTP Error:", error);
    res.status(500).json({ success: false, error: 'Failed to send reset OTP.' });
  }
};

// @desc    Soft delete user account & anonymize data
// @route   DELETE /api/v1/auth/delete-account
// @access  Private
exports.deleteAccount = async (req, res, next) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Generate a random suffix to preserve unique constraints (email/phone)
    const randomSuffix = crypto.randomBytes(4).toString('hex');

    // 1. Anonymize the User Document
    user.name = "Deleted User";
    user.email = `deleted_${userId}_${randomSuffix}@ybconnect.in`;
    user.phoneNumber = `deleted_${userId}_${randomSuffix}`;
    user.slug = `deleted_${userId}_${randomSuffix}`;
    user.expoPushToken = undefined;
    
    // Scramble password so they can never log back in
    user.password = crypto.randomBytes(20).toString('hex');

    // Apply Soft Delete Flags
    user.isDeleted = true;
    user.deletedAt = Date.now();
    user.accountStatus = 'deleted';

    await user.save();

    // 2. Anonymize the Profile Document
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

    res.status(200).json({ 
      success: true, 
      message: 'Account securely deleted and anonymized.' 
    });

  } catch (error) {
    console.error("Delete Account Error:", error);
    res.status(500).json({ success: false, error: 'Failed to delete account' });
  }
};