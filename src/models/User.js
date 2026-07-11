const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
// --- ENTERPRISE FIX START ---
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
  // Role field completely removed!
  createdAt: { type: Date, default: Date.now },
  // --- NEW FIELD FOR NOTIFICATIONS ---
  expoPushToken: { type: String },

  // 🚨 NEW: Just add the phone number field
  phoneNumber: { 
    type: String, 
    required: true, 
    unique: true 
  },

  // 🚨 ADD THIS NEW FIELD:
  slug: { 
    type: String, 
    unique: true, 
    lowercase: true, 
    trim: true,
    sparse: true // This prevents errors for your old users who don't have a slug yet!
  },



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