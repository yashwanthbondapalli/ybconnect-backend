const mongoose = require('mongoose');

const ProfileSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true 
  },
  
  // NOTE: 'name' and 'phoneNumber' are kept here so we don't break your existing database,
  // even though they also exist on the User model.
  phoneNumber: { type: String, trim: true },

  category: { type: String, trim: true },
  city: { type: String, trim: true }, // 🚨 NEW
  companyName: { type: String, trim: true }, // 🚨 NEW
  designation: { type: String, maxLength: 100 }, 
  bio: { type: String, maxLength: 500 }, 
  skills: { type: [String], default: [] },
  languages: { type: [String], default: [] }, // 🚨 NEW
  experience: { type: String }, 
  yearsOfExperience: { type: Number, default: 0 }, // 🚨 NEW
  achievements: { type: String }, 
  hourlyRate: { 
    type: Number, 
    default: 0,
    min: [0, 'Hourly rate cannot be negative'] 
  },
  profileImage: { type: String, default: 'default-avatar.png' },

  // 🚨 NEW: Social Links Object
  socialLinks: {
    linkedin: { type: String },
    instagram: { type: String },
    xUrl: { type: String },
    website: { type: String }
  },

  zoomCredentials: {
    accessToken: { type: String },
    refreshToken: { type: String },
    accountId: { type: String },
    isConnected: { type: Boolean, default: false }
  },

  razorpayAccountId: { type: String, default: null },
  isPayoutActive: { type: Boolean, default: false },
  accountNumber: { type: String }, 
  ifscCode: { type: String },      
  
}, { timestamps: true });

module.exports = mongoose.model('Profile', ProfileSchema);