// models/Payout.js
const mongoose = require('mongoose');

const PayoutSchema = new mongoose.Schema({
  expert: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  grossAmount: { 
    type: Number, 
    required: true 
  },
  platformFee: { 
    type: Number, 
    required: true 
  },
  netPayable: { 
    type: Number, 
    required: true 
  },
  status: { 
    type: String, 
    enum: ['pending', 'processing', 'completed', 'failed'], 
    default: 'pending' 
  },
  // We save a snapshot of the bank details at the time of the request
  // so if they change it later, your historical records stay accurate.
  bankDetailsSnapshot: {
    accountNumber: { type: String, required: true },
    ifscCode: { type: String, required: true }
  },
  // An array of the specific CallRequests this payout covers
  includedSessions: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'CallRequest' 
  }],
  adminNotes: { type: String }, // For you to log transaction IDs on Fridays
  paidAt: { type: Date }
}, { timestamps: true });

module.exports = mongoose.model('Payout', PayoutSchema);