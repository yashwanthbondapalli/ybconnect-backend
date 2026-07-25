const mongoose = require('mongoose');

const PayoutSchema = new mongoose.Schema({
  // 1. IDENTITY
  expert: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  // 🚨 NEW: Distinguish between earnings and refunds
  payoutType: { type: String, enum: ['earning', 'refund'], default: 'earning' },
  
  // 2. DESTINATION (Provided by the user at the exact moment of withdrawal)
  upiId: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phoneNumber: { type: String, required: true, trim: true },

  // 3. THE MONEY
  financials: {
    grossAmount: { type: Number, required: true },
    platformFee: { type: Number, required: true },
    netPayable: { type: Number, required: true }
  },

  // 4. LIFETIME STATS SNAPSHOT (At the time of this request)
  stats: {
    totalCallsCompleted: { type: Number, default: 0 },
    totalCallsRejected: { type: Number, default: 0 }, // includes rejected, cancelled, no-shows
    totalRequestsReceived: { type: Number, default: 0 },
    totalRequestsSent: { type: Number, default: 0 } 
  },

  // 5. DETAILED RECEIPTS (Instead of just blind IDs, we store exactly what the money was for)
  includedSessions: [{
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallRequest' },
    requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    topic: { type: String },
    amountEarned: { type: Number },
    date: { type: Date }
  }],

  // 6. LOGISTICS
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'completed', 'failed'], 
    default: 'pending' 
  },
  adminNotes: { type: String }, // e.g., "PhonePe Txn: T238492834"
  paidAt: { type: Date }
  
}, { timestamps: true });

module.exports = mongoose.model('Payout', PayoutSchema);