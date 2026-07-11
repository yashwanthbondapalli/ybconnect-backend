const Profile = require('../models/Profile');
const User = require('../models/User');
const generateUniqueSlug = require('../utils/generateSlug');
// @desc    Get current user's profile
exports.getCurrentUserProfile = async (req, res, next) => {
  try {
    const profile = await Profile.findOne({ user: req.user.id })
      .populate('user', ['name', 'email']);

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'There is no profile for this user'
      });
    }

    res.status(200).json({
      success: true,
      data: profile
    });
  } catch (error) {
    next(error);
  }
};


// @desc    Create or Update Profile
exports.upsertProfile = async (req, res, next) => {
  try {
    // 1. Grab everything coming from the mobile app
    const {
      name,
      phoneNumber,
      designation, 
      companyName, 
      category, 
      city, 
      bio, 
      skills, 
      experience, 
      yearsOfExperience, 
      languages, 
      achievements, 
      hourlyRate, 
      profileImage, 
      socialLinks,
      upiId // 🚨 1. NEW: Extract upiId from the frontend request!
    } = req.body;

    // 🚨 UPGRADED FIX: Update Name AND dynamically regenerate the Slug
    if (name && name.trim() !== '') {
      const cleanName = name.trim();
      const currentUser = await User.findById(req.user.id);
      
      if (currentUser.name !== cleanName || !currentUser.slug) {
        const newSlug = await generateUniqueSlug(cleanName);
        
        await User.findByIdAndUpdate(req.user.id, { 
          name: cleanName,
          slug: newSlug 
        });
        
        console.log(`🔄 Profile Name changed! New slug generated: ${newSlug}`);
      }
    }

    // 2. Build the profile object
    const profileFields = {
      user: req.user.id,
      designation,
      companyName,     
      category,
      city,            
      bio,
      experience,
      yearsOfExperience: Number(yearsOfExperience) || 0, 
      achievements,
      hourlyRate: Number(hourlyRate) || 0,
      profileImage: profileImage || 'default-avatar.png',
    };

    // 🚨 2. NEW: Attach upiId securely to the MongoDB object
    if (upiId && upiId.trim() !== '') profileFields.upiId = upiId.trim();

    if (phoneNumber && phoneNumber.trim() !== '') profileFields.phoneNumber = phoneNumber;

    // 3. Handle Arrays (Skills & Languages)
    if (skills) profileFields.skills = Array.isArray(skills) ? skills : skills.split(',').map(s => s.trim());
    if (languages) profileFields.languages = Array.isArray(languages) ? languages : languages.split(',').map(l => l.trim()); 

    // 4. Handle Social Links Object 
    if (socialLinks) {
      profileFields.socialLinks = {};
      if (socialLinks.linkedin) profileFields.socialLinks.linkedin = socialLinks.linkedin;
      if (socialLinks.instagram) profileFields.socialLinks.instagram = socialLinks.instagram;
      if (socialLinks.xUrl) profileFields.socialLinks.xUrl = socialLinks.xUrl;
      if (socialLinks.website) profileFields.socialLinks.website = socialLinks.website;
    }

    // 5. Save to MongoDB
    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      { $set: profileFields },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    ).populate('user', 'name email slug phoneNumber');

    res.status(200).json({ success: true, data: profile });

  } catch (error) {
    next(error);
  }
};

// @desc    Get profile by user ID (Public View)
exports.getProfileByUserId = async (req, res, next) => {
  try {
    const profile = await Profile.findOne({ user: req.params.userId })
      // 🚨 SECURITY FIX: Exclude sensitive financial data from public view
      .select('-upiId') 
      // 🚨 SECURITY FIX: Only grab public info from the User model (no email/phone)
      .populate('user', 'name slug'); 

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found for this user' });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};


// @desc    Get profile by slug (Public View for Web/App)
exports.getProfileBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    const user = await User.findOne({ slug }).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'Expert not found' });
    }

    const profile = await Profile.findOne({ user: user._id })
      // 🚨 SECURITY FIX: Exclude UPI ID
      .select('-upiId') 
      // 🚨 SECURITY FIX: Do not leak email or phone number to the public!
      .populate('user', 'name slug'); 

    if (!profile) {
      return res.status(200).json({ 
        success: true, 
        data: {
          user: { name: user.name, slug: user.slug },
          designation: 'New Expert',
          bio: 'This expert is still setting up their profile.',
          skills: [],
          languages: [],
          hourlyRate: 0,
          profileImage: 'default-avatar.png'
        }
      });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error("Error fetching profile by slug:", error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Toggle Live Status (Instant Solver)
exports.toggleLiveStatus = async (req, res, next) => {
  try {
    const { isLive, status } = req.body;
    
    // Automatically set status based on the toggle if not explicitly provided
    const newStatus = status || (isLive ? 'available' : 'offline');

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      { 
        $set: { 
          isLive: isLive, 
          liveConnectionStatus: newStatus,
          lastActiveAt: Date.now() // Refreshes their heartbeat
        } 
      },
      { new: true }
    ).populate('user', 'name email slug');

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error("Live Toggle Error:", error);
    res.status(500).json({ success: false, message: 'Server error while toggling live status' });
  }
};