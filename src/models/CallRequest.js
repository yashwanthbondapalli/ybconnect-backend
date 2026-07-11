const mongoose = require('mongoose');

const CallRequestSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topic: { type: String, required: true, maxLength: 100 },
  message: { type: String, maxLength: 500 },
  status: { type: String, enum: ['pending', 'accepted', 'rejected', 'completed','cancelled'], default: 'pending' },
  scheduledAt: { type: Date },
  amount: { type: Number },
  reminderEmailSent: { type: Boolean, default: false },

// --- NEW PAYMENT FIELDS ---
// --- NEW PAYMENT FIELDS ---
  paymentStatus: { 
    type: String, 
    enum: ['pending', 'paid', 'failed', 'payout_ready', 'payout_processing'], 
    default: 'pending' 
  },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },

  // Add this inside your Request Schema
  zoomMeeting: {
    meetingId: { type: String },
    startUrl: { type: String }, // The Expert's private Host link
    joinUrl: { type: String },  // The Student's Guest link
    expertJoinedAt: { type: Date },
    studentJoinedAt: { type: Date },
    lastParticipantJoinTime: { type: Date }, // 👈 ADD THIS NEW LINE!
    durationSeconds: { type: Number, default: 0 },
    actualDurationMinutes: { type: Number, default: 0 }, // ✅ NEW FIELD,
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