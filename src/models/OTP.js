const mongoose = require('mongoose');

const OTPSchema = new mongoose.Schema({
  email: { type: String, required: true },
  otp: { type: String, required: true },
  // 🚨 This automatically deletes the document after 10 minutes (600 seconds)
  createdAt: { type: Date, default: Date.now, expires: 600 } 
});

module.exports = mongoose.model('OTP', OTPSchema);