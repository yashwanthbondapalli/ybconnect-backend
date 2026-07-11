const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email']
  },
  password: { 
    type: String, 
    required: true, 
    select: false,
    minlength: [6, 'Password must be at least 6 characters'] 
  },
  passwordChangedAt: Date,
  createdAt: { type: Date, default: Date.now },
  expoPushToken: { type: String },
  phoneNumber: { 
    type: String, 
    required: true, 
    unique: true 
  },
  slug: { 
    type: String, 
    unique: true, 
    lowercase: true, 
    trim: true,
    sparse: true 
  },
  // 🚨 NEW: SOFT DELETE FLAGS
  isDeleted: { type: Boolean, default: false },
  deletedAt: { type: Date },
  accountStatus: { type: String, enum: ['active', 'deleted', 'suspended'], default: 'active' }
});

UserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

UserSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);