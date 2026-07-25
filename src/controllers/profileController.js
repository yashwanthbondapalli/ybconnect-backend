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
    // 1. Extract ALL fields (Expert & Student) from the request body
    const {
      role, yearOfStudy, university, major, minor, studentLookingFor, 
      techInterests, techSkills, softSkills, studentProjects, internships, certifications, leadership, interests, // 🚀 NEW STUDENT FIELDS
      name, phoneNumber, designation, companyName, 
      shortDescription, whyBookMe, category, city, bio, 
      skills, industries, experience, servicesOffered, portfolio, availability,
      yearsOfExperience, languages, achievements, hourlyRate, 
      profileImage, socialLinks,
    } = req.body;

    // 2. Update Name AND dynamically regenerate the Slug
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

    // 3. Build the profileFields object
    const profileFields = {
      user: req.user.id,
      role: role || 'expert',
      
      // Basic & Shared
      designation, companyName, shortDescription, whyBookMe, category, city, bio,
      yearsOfExperience: Number(yearsOfExperience) || 0, 
      achievements,
      hourlyRate: Number(hourlyRate) || 0,
      profileImage: profileImage || 'default-avatar.png',
      
      // Student Specific Text Fields
      yearOfStudy, university, major, minor, studentLookingFor, techInterests,
      studentProjects, internships, certifications, leadership
    };

    if (phoneNumber && phoneNumber.trim() !== '') profileFields.phoneNumber = phoneNumber;
    if (availability) profileFields.availability = availability;



    // 5. Handle Arrays (Comma separated strings from frontend)
    if (skills) profileFields.skills = Array.isArray(skills) ? skills : skills.split(',').map(s => s.trim()).filter(Boolean);
    if (techSkills) profileFields.techSkills = Array.isArray(techSkills) ? techSkills : techSkills.split(',').map(s => s.trim()).filter(Boolean);
    if (softSkills) profileFields.softSkills = Array.isArray(softSkills) ? softSkills : softSkills.split(',').map(s => s.trim()).filter(Boolean);
    if (languages) profileFields.languages = Array.isArray(languages) ? languages : languages.split(',').map(l => l.trim()).filter(Boolean); 
    if (industries) profileFields.industries = Array.isArray(industries) ? industries : industries.split(',').map(i => i.trim()).filter(Boolean); 
    if (interests) profileFields.interests = Array.isArray(interests) ? interests : interests.split(',').map(i => i.trim()).filter(Boolean); 

    // 6. Handle Structured Arrays (JSON)
    if (experience) profileFields.experience = typeof experience === 'string' ? JSON.parse(experience) : experience;
    if (servicesOffered) profileFields.servicesOffered = typeof servicesOffered === 'string' ? JSON.parse(servicesOffered) : servicesOffered;
    if (portfolio) profileFields.portfolio = typeof portfolio === 'string' ? JSON.parse(portfolio) : portfolio;

    // 7. Handle Social Links (Including new GitHub & LeetCode)
    if (socialLinks) {
      profileFields.socialLinks = {
        linkedin: socialLinks.linkedin || '',
        instagram: socialLinks.instagram || '',
        xUrl: socialLinks.xUrl || '',
        website: socialLinks.website || '',
        github: socialLinks.github || '',     // 🚀 ADDED
        leetcode: socialLinks.leetcode || ''  // 🚀 ADDED
      };
    }

    // 8. Save to MongoDB
    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      { $set: profileFields },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    ).populate('user', 'name email slug phoneNumber');

    res.status(200).json({ success: true, data: profile });

  } catch (error) {
    console.error("Profile Upsert Error:", error);
    next(error);
  }
};

// @desc    Get profile by user ID (Public View)
exports.getProfileByUserId = async (req, res, next) => {
  try {
    const profile = await Profile.findOne({ user: req.params.userId })
      // 🚨 SECURITY FIX: Exclude sensitive financial data from public view
      
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

// Add this new function to controllers/profileController.js
exports.getProfileByAnyId = async (req, res, next) => {
  try {
    const { id } = req.params;
    
    // First try finding by User ID (standard)
    let profile = await Profile.findOne({ user: id }).populate('user', 'name slug');
    
    // If not found, try finding by the Profile's own ID
    if (!profile) {
      profile = await Profile.findById(id).populate('user', 'name slug');
    }

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
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

// @desc    Get all Student Profiles for the Home Screen Talent Section
// @route   GET /api/v1/profile/talent
// @access  Public or Protected
exports.getStudentTalent = async (req, res, next) => {
  try {
    const { intent } = req.query; // Gets the filter from the frontend (e.g., ?intent=Internships)
    
    // Base query: Only find students
    let query = { role: 'student' };

    // If the user clicked a specific filter (and not 'All Talent')
    if (intent && intent !== 'All') {
      // 🚀 THE MAGIC: Search INSIDE the comma-separated string!
      query.studentLookingFor = { $regex: intent, $options: 'i' }; 
    }

    const students = await Profile.find(query)
      .populate('user', 'name slug')
      .sort({ createdAt: -1 }); // Newest students first

    res.status(200).json({ 
      success: true, 
      count: students.length,
      data: students 
    });
  } catch (error) {
    console.error("Error fetching talent:", error);
    res.status(500).json({ success: false, error: 'Server Error fetching talent' });
  }
};

// @desc    Auto-save just the profile picture

exports.updateProfileImage = async (req, res, next) => {
  try {
    // 🚨 FIX: Extract the role from the request body
    const { profileImage, role } = req.body; 
    
    if (!profileImage) {
      return res.status(400).json({ success: false, error: 'No image URL provided' });
    }

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      { 
        $set: { profileImage: profileImage },
        // 🚨 FIX: If creating a NEW profile, use the role they selected on screen!
        $setOnInsert: { role: role || 'expert' } 
      },
      { 
        new: true, 
        upsert: true, 
        setDefaultsOnInsert: true 
      } 
    );

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error("Image Auto-Save Error:", error);
    res.status(500).json({ success: false, error: 'Failed to auto-save image' });
  }
};