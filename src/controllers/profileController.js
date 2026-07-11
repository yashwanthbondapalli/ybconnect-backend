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
      socialLinks
    } = req.body;

// 🚨 UPGRADED FIX: Update Name AND dynamically regenerate the Slug
    if (name && name.trim() !== '') {
      const cleanName = name.trim();
      const currentUser = await User.findById(req.user.id);
      
      // Only generate a new slug if they ACTUALLY changed their name (or if a slug is missing)
      // This prevents the system from making "-1", "-2" versions every time they save their bio!
      if (currentUser.name !== cleanName || !currentUser.slug) {
        const newSlug = await generateUniqueSlug(cleanName);
        
        await User.findByIdAndUpdate(req.user.id, { 
          name: cleanName,
          slug: newSlug // Save the fresh slug to the database
        });
        
        console.log(`🔄 Profile Name changed! New slug generated: ${newSlug}`);
      }
    }

    // 2. Build the profile object (Notice we completely removed name from here)
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
    // 🚨 THE FIX: Added .populate() at the end so the app instantly gets the new name back!
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

// @desc    Get profile by user ID
exports.getProfileByUserId = async (req, res, next) => {
  try {
    const profile = await Profile.findOne({
      user: req.params.userId
    }).populate('user', ['name', 'email']);

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'Profile not found for this user'
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



exports.getProfileBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    // 1. Find the User using the unique slug
    const user = await User.findOne({ slug }).select('-password');
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'Expert not found' });
    }

    // 2. Fetch the rich Profile data using that User's _id
    // We use .populate('user') so the frontend gets the slug and email attached to it!
    const profile = await Profile.findOne({ user: user._id }).populate('user', 'name email phoneNumber slug');

    // 3. Fallback: If they registered but haven't gone through ProfileSetupScreen yet
    if (!profile) {
      return res.status(200).json({ 
        success: true, 
        data: {
          user: user,
          name: user.name,
          designation: 'New Expert',
          bio: 'This expert is still setting up their profile.',
          skills: [],
          languages: [],
          hourlyRate: 0,
          profileImage: 'default-avatar.png'
        }
      });
    }

    // 4. Send the complete, rich profile back to the app
    res.status(200).json({ 
      success: true, 
      data: profile 
    });

  } catch (error) {
    console.error("Error fetching profile by slug:", error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};
