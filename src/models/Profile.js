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

// 🚨 NEW: Simple UPI ID for weekend payouts
  upiId: { type: String, trim: true },
  
  
  // 🚨 INSTANT SOLVER FIELDS
  isLive: { type: Boolean, default: false },
  lastActiveAt: { type: Date, default: Date.now },
  liveConnectionStatus: { 
    type: String, 
    enum: ['available', 'in_call', 'offline'], 
    default: 'offline' 
  },
  

  
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