const mongoose = require('mongoose');

const ProfileSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  phoneNumber: { type: String, trim: true },
  
  // 🚀 -- MASTER ROLE --
  role: { type: String, enum: ['expert', 'student'], default: 'expert' },

  // -- BASIC IDENTITY (SHARED) --
  designation: { type: String, maxLength: 100 }, 
  companyName: { type: String, trim: true }, 
  shortDescription: { type: String, maxLength: 150 }, 
  city: { type: String, trim: true },
  category: { type: String, trim: true }, 
  
  // -- ABOUT (SHARED) --
  bio: { type: String, maxLength: 800 }, 
  
  // -- EXPERT ONLY: ABOUT & PITCH --
  whyBookMe: { type: String, maxLength: 800 }, 
  
  // 🎓 -- STUDENT ONLY: ACADEMICS & RESUME --
  university: { type: String, trim: true },
  major: { type: String, trim: true },
  minor: { type: String, trim: true },
  yearOfStudy: { type: String, trim: true },
  studentLookingFor: { type: String, maxLength: 800 },
  studentProjects: { type: String, maxLength: 2000 },
  internships: { type: String, maxLength: 2000 },
  certifications: { type: String, maxLength: 2000 },
  leadership: { type: String, maxLength: 2000 },
  techInterests: { type: String, trim: true },

  // -- CHIPS & WIDGETS (ARRAYS) --
  skills: { type: [String], default: [] }, // Expert
  techSkills: { type: [String], default: [] }, // Student
  softSkills: { type: [String], default: [] }, // Student
  languages: { type: [String], default: [] }, // Shared
  industries: { type: [String], default: [] }, // Expert
  interests: { type: [String], default: [] }, // Student
  
  // 💰 -- LOGISTICS & PAYMENTS (SHARED) --
  upiId: { type: String, trim: true },
  isPayoutActive: { type: Boolean, default: false },
  zoomCredentials: { accessToken: String, refreshToken: String, accountId: String, isConnected: { type: Boolean, default: false } },
  hourlyRate: { type: Number, default: 0, min: 0 },
  
  // -- STRUCTURED SECTIONS (EXPERT ONLY) --
  experience: [{ 
    role: String,
    company: String,
    duration: String, // e.g., "2021 - 2023"
    description: String
  }],
  servicesOffered: [{
    title: String,
    icon: String // e.g., "rocket", "mobile", "code"
  }],
  portfolio: [{
    title: String,
    description: String,
    tag: String, // e.g., "Mobile App", "Web App"
    imageUrl: String,
    link: String
  }],

  yearsOfExperience: { type: Number, default: 0 }, 
  
  // -- AVAILABILITY WIDGET (SHARED LOGISTICS) --
  availability: {
    workingDays: { type: String, default: 'Mon - Fri' },
    workingHours: { type: String, default: '10:00 AM - 6:00 PM' },
    timezone: { type: String, default: '(GMT +05:30) IST' },
    avgResponseTime: { type: String, default: 'Usually replies in 24 hours' }
  },

  // -- MISC DETAILS & LINKS --
  achievements: { type: String }, // Shared
  profileImage: { type: String, default: 'default-avatar.png' },
  socialLinks: { 
    linkedin: String, 
    instagram: String, 
    xUrl: String, 
    website: String, 
    github: String,   // 🚀 NEW: For Student Mockup
    leetcode: String  // 🚀 NEW: For Student Mockup
  },
  
  // -- INSTANT SOLVER --
  isLive: { type: Boolean, default: false },
  lastActiveAt: { type: Date, default: Date.now },
  liveConnectionStatus: { type: String, enum: ['available', 'in_call', 'offline'], default: 'offline' },

}, { timestamps: true });

// 🚨 THE SECURITY PATCH: Automatically strip sensitive tokens before sending to the frontend
ProfileSchema.set('toJSON', {
  transform: function (doc, ret, options) {
    if (ret.zoomCredentials) {
      delete ret.zoomCredentials.accessToken;
      delete ret.zoomCredentials.refreshToken;
    }
    // Note: We leave 'isConnected' and 'accountId' so the frontend still works!
    return ret;
  }
});

module.exports = mongoose.model('Profile', ProfileSchema);