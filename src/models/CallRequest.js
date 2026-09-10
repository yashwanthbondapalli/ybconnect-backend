const mongoose = require('mongoose');

const CallRequestSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topic: { type: String, required: true, maxLength: 100 },
  message: { type: String, maxLength: 500 },
  
  // 🚀 NEW: Negotiation Fields
// 🚀 NEW: Negotiation Fields (OLD MODEL)
  budget: {
    min: { type: Number },
    max: { type: Number }
  },
  proposedSlots: [{ type: Date }], 
  
  // 🚀 NEW: INSTANT BOOKING LOCK TIMER
  expiresAt: { type: Date }, // If the student abandons checkout, Mongo auto-deletes this!

  // 🚨 UPDATED: Added 'holding' to the enum for the 10-minute checkout lock
  status: { type: String, enum: ['holding', 'pending', 'offer_made', 'accepted', 'rejected', 'completed', 'cancelled'], default: 'holding' },
  scheduledAt: { type: Date },
  amount: { type: Number }, // Set by the expert when they make the offer
  reminderEmailSent: { type: Boolean, default: false },

  // --- PAYMENT FIELDS ---
paymentStatus: { 
    type: String, 
    // 🚨 NEW: Added 'refund_processing' and 'refunded'
    enum: ['pending', 'paid', 'failed', 'payout_ready', 'payout_processing', 'refund_processing', 'refunded'], 
    default: 'pending' 
  },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },

  // --- ZOOM FIELDS ---
  zoomMeeting: {
    meetingId: { type: String },
    startUrl: { type: String }, 
    joinUrl: { type: String },  
    expertJoinedAt: { type: Date },
    studentJoinedAt: { type: Date },
    lastParticipantJoinTime: { type: Date }, 
    durationSeconds: { type: Number, default: 0 },
    actualDurationMinutes: { type: Number, default: 0 }, 
    status: { 
      type: String, 
      enum: ['waiting', 'in_progress', 'completed', 'expert_no_show', 'student_no_show'],
      default: 'waiting'
    }
  },

}, { timestamps: true });

CallRequestSchema.index({ requester: 1 });
CallRequestSchema.index({ recipient: 1 });
CallRequestSchema.index({ requester: 1, recipient: 1 });

// 🚀 NEW: The Self-Destruct Index! 
// MongoDB will automatically delete any document where the current time passes the 'expiresAt' time.
CallRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

CallRequestSchema.index(
  { recipient: 1, scheduledAt: 1 },
  { 
    unique: true, 
    partialFilterExpression: { status: { $in: ['holding', 'accepted'] } } 
  }
);

module.exports = mongoose.model('CallRequest', CallRequestSchema);