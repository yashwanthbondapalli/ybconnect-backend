const mongoose = require('mongoose');

const ProfileSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  phoneNumber: { type: String, trim: true },
  
  // -- BASIC IDENTITY --
  designation: { type: String, maxLength: 100 }, 
  companyName: { type: String, trim: true }, 
  shortDescription: { type: String, maxLength: 150 }, // 👈 NEW: The text right under the name
  city: { type: String, trim: true },
  category: { type: String, trim: true }, 
  
  // -- THE TWO-COLUMN INTRO --
  bio: { type: String, maxLength: 800 }, // "About Me"
  whyBookMe: { type: String, maxLength: 800 }, // 👈 NEW: Right column text
  
  // -- CHIPS & WIDGETS (ARRAYS) --
  skills: { type: [String], default: [] },
  languages: { type: [String], default: [] }, 
  industries: { type: [String], default: [] }, // 👈 NEW: e.g., ["SaaS", "EdTech"]
  lookingFor: { type: [String], default: [] }, // 👈 NEW: e.g., ["Clients", "Co-founders"]
  
  // -- STRUCTURED SECTIONS --
  // 👈 NEW: Replaces the flat string 'experience'
  experience: [{ 
    role: String,
    company: String,
    duration: String, // e.g., "2021 - 2023"
    description: String
  }],
  
  // 👈 NEW: Services Grid
  servicesOffered: [{
    title: String,
    icon: String // e.g., "rocket", "mobile", "code"
  }],

  // 👈 NEW: Portfolio Horizontal Scroll
  portfolio: [{
    title: String,
    description: String,
    tag: String, // e.g., "Mobile App", "Web App"
    imageUrl: String,
    link: String
  }],

  // -- LOGISTICS & METRICS --
  yearsOfExperience: { type: Number, default: 0 }, 
  hourlyRate: { type: Number, default: 0, min: 0 },
  
  // 👈 NEW: Availability Widget
  availability: {
    workingDays: { type: String, default: 'Mon - Fri' },
    workingHours: { type: String, default: '10:00 AM - 6:00 PM' },
    timezone: { type: String, default: '(GMT +05:30) IST' },
    avgResponseTime: { type: String, default: 'Usually replies in 24 hours' }
  },

  // -- EXISTING SYSTEM FIELDS --
  achievements: { type: String }, 
  profileImage: { type: String, default: 'default-avatar.png' },
  socialLinks: { linkedin: String, instagram: String, xUrl: String, website: String },
  zoomCredentials: { accessToken: String, refreshToken: String, accountId: String, isConnected: { type: Boolean, default: false } },
  upiId: { type: String, trim: true },
  
  // -- INSTANT SOLVER --
  isLive: { type: Boolean, default: false },
  lastActiveAt: { type: Date, default: Date.now },
  liveConnectionStatus: { type: String, enum: ['available', 'in_call', 'offline'], default: 'offline' },

}, { timestamps: true });

// (Keep your existing toJSON transform for security)

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