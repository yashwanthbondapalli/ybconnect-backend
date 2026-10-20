// backend/src/models/Profile.js
const mongoose = require('mongoose');

const DEFAULT_SESSION_PRICING = [
  { duration: 10, price: 10, minPrice: 10, isEnabled: true },
  { duration: 20, price: 299, minPrice: 299, isEnabled: true },
  { duration: 30, price: 499, minPrice: 499, isEnabled: true },
  { duration: 40, price: 599, minPrice: 599, isEnabled: true },
  { duration: 60, price: 999, minPrice: 999, isEnabled: true },
];

const TimeWindowSchema = new mongoose.Schema(
  {
    start: { type: String, required: true }, // e.g. "10:00" (24-hr IST)
    end: { type: String, required: true },   // e.g. "18:00" (24-hr IST)
  },
  { _id: false }
);

const ProfileSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  phoneNumber: { type: String, trim: true },

  // -- MASTER ROLE --
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

  // -- STUDENT ONLY: ACADEMICS & RESUME --
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
  skills: { type: [String], default: [] },
  techSkills: { type: [String], default: [] },
  softSkills: { type: [String], default: [] },
  languages: { type: [String], default: [] },
  industries: { type: [String], default: [] },
  interests: { type: [String], default: [] },

  // -- LOGISTICS, PAYOUTS & PRICING --
  // Kept for backward compatibility; defaults isConnected=true since LiveKit is native in-app
  zoomCredentials: {
    accessToken: String,
    refreshToken: String,
    accountId: String,
    isConnected: { type: Boolean, default: true },
  },
  accountNumber: { type: String, trim: true },
  ifscCode: { type: String, trim: true },
  isPayoutActive: { type: Boolean, default: false },
  razorpayAccountId: { type: String, default: 'manual_payout_mode' },

  // Base rate kept synced with the 30-min (or lowest enabled) tier for feed cards
  hourlyRate: { type: Number, default: 499, min: 0 },

  // 🚀 NEW: 5-TIER CONFIGURABLE PRICING WITH MINIMUM FLOORS
  sessionPricing: {
    type: [
      {
        duration: { type: Number, enum: [10, 20, 30, 40, 60], required: true },
        price: { type: Number, required: true, min: 10 },
        minPrice: { type: Number, required: true },
        isEnabled: { type: Boolean, default: true },
      },
    ],
    default: () => DEFAULT_SESSION_PRICING,
  },

  // -- STRUCTURED SECTIONS (EXPERT ONLY) --
  experience: [
    {
      type: { type: String, default: 'Job' },
      role: { type: String },
      company: { type: String },
      duration: { type: String },
      description: { type: String },
    },
  ],
  servicesOffered: [
    {
      title: String,
      icon: String,
    },
  ],
  portfolio: [
    {
      title: String,
      description: String,
      tag: String,
      imageUrl: String,
      link: String,
    },
  ],

  yearsOfExperience: { type: Number, default: 0 },

  // -- AVAILABILITY SUMMARY TEXT (DISPLAY WIDGET) --
  availability: {
    workingDays: { type: String, default: 'Mon - Fri' },
    workingHours: { type: String, default: '10:00 AM - 6:00 PM' },
    timezone: { type: String, default: 'Asia/Kolkata (IST, UTC+05:30)' },
    avgResponseTime: { type: String, default: 'Usually replies in 24 hours' },
  },

  // 🚀 UPGRADED: MULTI-SHIFT & PER-DAY SCHEDULING ENGINE
  scheduleRules: {
    timezone: { type: String, default: 'Asia/Kolkata' },
    scheduleMode: {
      type: String,
      enum: ['uniform', 'custom_per_day'],
      default: 'uniform',
    },
    sessionDuration: { type: Number, default: 30 },
    bufferDuration: { type: Number, default: 0 },
    noticePeriodHours: { type: Number, default: 0.166 }, // ~10 mins default notice
    days: [
      {
        dayOfWeek: { type: Number, min: 0, max: 6 }, // 0 = Sun, 1 = Mon ... 6 = Sat
        timeWindows: [TimeWindowSchema],
      },
    ],
    dateOverrides: [
      {
        date: { type: String }, // "YYYY-MM-DD" in expert's timezone
        isUnavailable: { type: Boolean, default: false },
        timeWindows: [TimeWindowSchema],
      },
    ],
    blackoutDates: [{ type: Date }],
  },

  // -- MISC DETAILS & LINKS --
  achievements: { type: String },
  profileImage: { type: String, default: 'default-avatar.png' },
  socialLinks: {
    linkedin: String,
    instagram: String,
    xUrl: String,
    website: String,
    github: String,
    leetcode: String,
  },

  // -- INSTANT SOLVER --
  isLive: { type: Boolean, default: false },
  lastActiveAt: { type: Date, default: Date.now },
  liveConnectionStatus: {
    type: String,
    enum: ['available', 'in_call', 'offline'],
    default: 'offline',
  },
}, { timestamps: true });

ProfileSchema.set('toJSON', {
  transform: function (doc, ret) {
    if (ret.zoomCredentials) {
      delete ret.zoomCredentials.accessToken;
      delete ret.zoomCredentials.refreshToken;
      ret.zoomCredentials.isConnected = true;
    }
    if (!ret.sessionPricing || ret.sessionPricing.length === 0) {
      ret.sessionPricing = DEFAULT_SESSION_PRICING;
    }
    return ret;
  },
});

module.exports = mongoose.model('Profile', ProfileSchema);