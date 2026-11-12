// backend/src/models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxLength: [80, 'Name cannot exceed 80 characters'],
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    maxLength: [254, 'Email is too long'],
    // ReDoS-safe regex supporting modern TLDs (.tech, .academy, .edu.in, etc.)
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please provide a valid email address'],
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    maxLength: [128, 'Password cannot exceed 128 characters'],
    select: false,
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user',
  },
  passwordChangedAt: {
    type: Date,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  expoPushToken: {
    type: String,
    trim: true,
    default: null,
  },
  phoneNumber: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    trim: true,
    match: [/^[0-9]{10}$/, 'Phone number must be exactly 10 digits'],
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true,
    sparse: true,
  },
  // Soft Delete & Moderation Flags
  isDeleted: {
    type: Boolean,
    default: false,
  },
  deletedAt: {
    type: Date,
  },
  accountStatus: {
    type: String,
    enum: ['active', 'deleted', 'suspended'],
    default: 'active',
  },
});

// Automatically hash password AND update passwordChangedAt to revoke old JWTs
UserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);

  // If this is an existing user changing/resetting their password, invalidate old tokens
  if (!this.isNew) {
    this.passwordChangedAt = new Date(Date.now() - 1000);
  }
});

UserSchema.methods.matchPassword = async function (enteredPassword) {
  if (typeof enteredPassword !== 'string' || !this.password) return false;
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);