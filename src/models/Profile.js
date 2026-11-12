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

const ProfileSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    phoneNumber: { type: String, trim: true },

    // -- MASTER ROLE (Defaults to 'student' until Mentor Verification is approved) --
    role: { type: String, enum: ['expert', 'student'], default: 'student' },

    // 🚀 MENTOR TRUST, VERIFICATION & INTERVIEW GATE
    mentorApplicationStatus: {
      type: String,
      enum: ['none', 'pending', 'interview_scheduled', 'approved', 'rejected'],
      default: 'none',
    },
    mentorApplication: {
      fullName: { type: String, trim: true },
      phoneNumber: { type: String, trim: true },
      designation: { type: String, trim: true },
      companyName: { type: String, trim: true },
      category: { type: String, trim: true },
      yearsOfExperience: { type: Number, default: 0 },
      linkedinUrl: { type: String, trim: true },
      portfolioUrl: { type: String, trim: true },
      preferredInterviewTime: { type: String, trim: true },
      whyMentor: { type: String, maxLength: 1000 },
      interviewScheduledAt: { type: String, trim: true },
      interviewLink: { type: String, trim: true },
      adminNotes: { type: String, maxLength: 500 },
      submittedAt: { type: Date },
      reviewedAt: { type: Date },
    },

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

    hourlyRate: { type: Number, default: 499, min: 0 },

    // 🚀 5-TIER CONFIGURABLE PRICING WITH MINIMUM FLOORS
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

    // -- AVAILABILITY SUMMARY TEXT --
    availability: {
      workingDays: { type: String, default: 'Mon - Fri' },
      workingHours: { type: String, default: '10:00 AM - 6:00 PM' },
      timezone: { type: String, default: 'Asia/Kolkata (IST, UTC+05:30)' },
      avgResponseTime: { type: String, default: 'Usually replies in 24 hours' },
    },

    // 🚀 MULTI-SHIFT & PER-DAY SCHEDULING ENGINE
    scheduleRules: {
      timezone: { type: String, default: 'Asia/Kolkata' },
      scheduleMode: {
        type: String,
        enum: ['uniform', 'custom_per_day'],
        default: 'uniform',
      },
      sessionDuration: { type: Number, default: 30 },
      bufferDuration: { type: Number, default: 0 },
      noticePeriodHours: { type: Number, default: 0.166 },
      days: [
        {
          dayOfWeek: { type: Number, min: 0, max: 6 },
          timeWindows: [TimeWindowSchema],
        },
      ],
      dateOverrides: [
        {
          date: { type: String },
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
  },
  { timestamps: true }
);

ProfileSchema.set('toJSON', {
  transform: function (doc, ret) {
    delete ret.accountNumber;
    delete ret.ifscCode;
    delete ret.razorpayAccountId;
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