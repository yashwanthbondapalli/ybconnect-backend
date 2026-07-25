const mongoose = require('mongoose');

const CallRequestSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topic: { type: String, required: true, maxLength: 100 },
  message: { type: String, maxLength: 500 },
  
  // 🚀 NEW: Negotiation Fields
  budget: {
    min: { type: Number },
    max: { type: Number }
  },
  proposedSlots: [{ type: Date }], // The 1-3 times the expert offers
  
  // 🚨 UPDATED: Added 'offer_made' to the enum
status: { type: String, enum: ['pending', 'offer_made', 'accepted', 'rejected', 'completed', 'cancelled'], default: 'pending' },
  scheduledAt: { type: Date }, // Set by the student when they accept the offer
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

module.exports = mongoose.model('CallRequest', CallRequestSchema);