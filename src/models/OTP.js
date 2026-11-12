// backend/src/models/OTP.js
const mongoose = require('mongoose');
const crypto = require('crypto');

const MAX_OTP_ATTEMPTS = 5;

const OTPSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true,
  },
  otp: {
    type: String,
    required: true,
  },
  attempts: {
    type: Number,
    default: 0,
  },
  // Automatically deletes the OTP document after 10 minutes (600 seconds)
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 600,
  },
});

/**
 * Timing-safe OTP verification with automatic 5-strike self-destruct.
 * Even if an attacker changes their IP address on every request, the OTP is destroyed on the 5th wrong guess.
 */
OTPSchema.statics.verifyAndConsume = async function (rawEmail, rawOtp) {
  if (typeof rawEmail !== 'string' || typeof rawOtp !== 'string') {
    return false;
  }

  const email = rawEmail.toLowerCase().trim();
  const candidateOtp = rawOtp.trim();

  if (!/^[0-9]{6}$/.test(candidateOtp)) {
    return false;
  }

  const record = await this.findOne({ email });
  if (!record) {
    return false;
  }

  const storedBuf = Buffer.from(String(record.otp));
  const candidateBuf = Buffer.from(candidateOtp);

  const isMatch =
    storedBuf.length === candidateBuf.length &&
    crypto.timingSafeEqual(storedBuf, candidateBuf);

  if (isMatch) {
    await this.deleteMany({ email });
    return true;
  }

  // Increment failed attempts; destroy OTP if limit reached
  record.attempts = (record.attempts || 0) + 1;
  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    await this.deleteMany({ email });
  } else {
    await record.save();
  }

  return false;
};

module.exports = mongoose.model('OTP', OTPSchema);