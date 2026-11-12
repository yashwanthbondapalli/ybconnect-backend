// backend/src/models/Payout.js
const mongoose = require('mongoose');

const PayoutSchema = new mongoose.Schema(
  {
    // 1. IDENTITY (Mentor for 'earning', Student for 'refund')
    expert: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    payoutType: {
      type: String,
      enum: ['earning', 'refund'],
      default: 'earning',
    },

    // 2. DESTINATION (Validated to block injection payloads)
    upiId: {
      type: String,
      required: [true, 'UPI ID is required'],
      trim: true,
      maxLength: [100, 'UPI ID cannot exceed 100 characters'],
      match: [
        /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z]{2,32}$/,
        'Please provide a valid UPI ID (e.g. name@okaxis)',
      ],
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxLength: 254,
    },
    phoneNumber: {
      type: String,
      required: true,
      trim: true,
      maxLength: 15,
    },

    // 3. THE MONEY (Strictly non-negative)
    financials: {
      grossAmount: { type: Number, required: true, min: 0 },
      platformFee: { type: Number, required: true, min: 0 },
      netPayable: { type: Number, required: true, min: 1 },
    },

    // 4. LIFETIME STATS SNAPSHOT
    stats: {
      totalCallsCompleted: { type: Number, default: 0, min: 0 },
      totalCallsRejected: { type: Number, default: 0, min: 0 },
      totalRequestsReceived: { type: Number, default: 0, min: 0 },
      totalRequestsSent: { type: Number, default: 0, min: 0 },
    },

    // 5. DETAILED AUDIT RECEIPTS
    includedSessions: [
      {
        sessionId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'CallRequest',
          required: true,
        },
        requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        topic: { type: String, maxLength: 150 },
        amountEarned: { type: Number, min: 0 },
        date: { type: Date },
      },
    ],

    // 6. LOGISTICS
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
    },
    adminNotes: { type: String, maxLength: 500 },
    paidAt: { type: Date },
  },
  { timestamps: true }
);

// Prevent multiple active payout/refund requests for the same user and payout type
PayoutSchema.index(
  { expert: 1, payoutType: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ['pending', 'processing'] },
    },
  }
);

PayoutSchema.index({ 'includedSessions.sessionId': 1, payoutType: 1 });

module.exports = mongoose.model('Payout', PayoutSchema);