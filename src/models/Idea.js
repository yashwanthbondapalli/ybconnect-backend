// backend/src/models/Idea.js
const mongoose = require('mongoose');

const IdeaSchema = new mongoose.Schema(
  {
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    authorName: { type: String, required: true },
    profileImage: { type: String, default: 'default-avatar.png' },
    designation: { type: String, default: '' },
    company: { type: String, default: '' },

    // 🚀 STRUCTURED JOB FIELDS
    jobTitle: {
      type: String,
      trim: true,
      maxlength: [140, 'Job title cannot exceed 140 characters'],
      default: '',
    },
    companyName: {
      type: String,
      trim: true,
      maxlength: [120, 'Company name cannot exceed 120 characters'],
      default: '',
    },
    jobType: {
      type: String,
      enum: ['Full-Time', 'Internship', 'Referral', 'Contract', 'Freelance'],
      default: 'Full-Time',
    },
    workMode: {
      type: String,
      enum: ['Remote', 'Hybrid', 'On-Site'],
      default: 'On-Site',
    },
    location: {
      type: String,
      trim: true,
      maxlength: [120, 'Location cannot exceed 120 characters'],
      default: '',
    },
    stipendOrSalary: {
      type: String,
      trim: true,
      maxlength: [100, 'Salary/Stipend cannot exceed 100 characters'],
      default: '',
    },
    experienceRequired: {
      type: String,
      trim: true,
      maxlength: [100, 'Experience cannot exceed 100 characters'],
      default: '',
    },
    skillsRequired: {
      type: [String],
      default: [],
    },
    applyLink: {
      type: String,
      trim: true,
      maxlength: [600, 'Application link cannot exceed 600 characters'],
      default: '',
    },
    isLinkVerified: {
      type: Boolean,
      default: false,
    },

    category: {
      type: String,
      enum: [
        'Technology',
        'Engineering',
        'Design',
        'Business',
        'Startup',
        'Marketing',
        'Finance',
        'Career',
        'Other',
      ],
      default: 'Technology',
    },

    // Supports up to 2,000 words (~15,000 characters)
    message: {
      type: String,
      required: [true, 'Job description cannot be empty'],
      maxlength: [15000, 'Job description cannot exceed 2000 words (15000 characters)'],
      trim: true,
    },

    likesCount: { type: Number, default: 0 },

    likedBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
  },
  {
    timestamps: true,
    strict: false, // Prevents Mongoose from ever stripping new job fields
  }
);

IdeaSchema.index({ createdAt: -1 });
IdeaSchema.index({ category: 1, createdAt: -1 });
IdeaSchema.index({ jobType: 1, createdAt: -1 });
IdeaSchema.index({ likesCount: -1 });

module.exports = mongoose.model('Idea', IdeaSchema);