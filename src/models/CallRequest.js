// backend/src/models/CallRequest.js
const mongoose = require('mongoose');

const ReviewSubSchema = new mongoose.Schema(
  {
    rating: { type: Number, min: 1, max: 5 },
    feedback: { type: String, maxLength: 500 },
    submittedAt: { type: Date },
  },
  { _id: false }
);

const CallRequestSchema = new mongoose.Schema({
  requester: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  topic: { type: String, required: true, maxLength: 100 },
  message: { type: String, maxLength: 500 },

  // Custom Offer / Negotiation Fields
  budget: {
    min: { type: Number },
    max: { type: Number },
  },
  proposedSlots: [{ type: Date }],

  // 10-Minute Checkout Lock Timer (MongoDB TTL Index)
  expiresAt: { type: Date },

  status: {
    type: String,
    enum: ['holding', 'pending', 'offer_made', 'accepted', 'rejected', 'completed', 'cancelled'],
    default: 'holding',
  },

  // 🚀 TIMING & DURATION FIELDS
  scheduledAt: { type: Date },
  scheduledEndAt: { type: Date },
  durationMinutes: {
    type: Number,
    enum: [10, 20, 30, 40, 60],
    default: 30,
  },
  timezone: { type: String, default: 'Asia/Kolkata' },

  // 🚀 PRICING & COMMISSION SNAPSHOT
  amount: { type: Number },
  financials: {
    grossAmount: { type: Number, default: 0 },
    platformFeePercent: { type: Number, default: 10 },
    platformFeeAmount: { type: Number, default: 0 },
    expertNetAmount: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
  },

  reminderEmailSent: { type: Boolean, default: false },
  nudgesSent: { type: Number, default: 0 },

  // --- PAYMENT FIELDS ---
  paymentStatus: {
    type: String,
    enum: [
      'pending',
      'paid',
      'failed',
      'payout_ready',
      'payout_processing',
      'refund_processing',
      'refunded',
    ],
    default: 'pending',
  },
  razorpayOrderId: { type: String },
  razorpayPaymentId: { type: String },

  // 🚀 LIVEKIT VIDEO SESSION STATE MACHINE
  videoProvider: {
    type: String,
    enum: ['livekit', 'zoom'],
    default: 'livekit',
  },
  videoSession: {
    roomName: { type: String },
    roomSid: { type: String },
    status: {
      type: String,
      enum: [
        'waiting',
        'in_progress',
        'completed',
        'expert_no_show',
        'student_no_show',
        'both_no_show',
      ],
      default: 'waiting',
    },
    expertLastSeenAt: { type: Date },
    studentLastSeenAt: { type: Date },
    expertJoinedAt: { type: Date },
    studentJoinedAt: { type: Date },
    expertLastJoinedAt: { type: Date },
    studentLastJoinedAt: { type: Date },
    expertLeftAt: { type: Date },
    studentLeftAt: { type: Date },
    overlapStartedAt: { type: Date },
    expertPresentSeconds: { type: Number, default: 0 },
    studentPresentSeconds: { type: Number, default: 0 },
    bothConnectedSeconds: { type: Number, default: 0 },
    actualDurationMinutes: { type: Number, default: 0 },
    completionReason: { type: String },
    endedAt: { type: Date },
    processedWebhookIds: [{ type: String }],
  },

  // --- LEGACY ZOOM FIELDS (Kept synced with videoSession for 100% backward compatibility) ---
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
      default: 'waiting',
    },
    review: ReviewSubSchema,
  },

  // 🚀 ROOT-LEVEL REVIEW (Fixed from being nested inside zoomMeeting)
  review: ReviewSubSchema,
}, { timestamps: true });

// Automatically compute scheduledEndAt and financials snapshot before saving
CallRequestSchema.pre('save', function () {
  const duration = Number(this.durationMinutes) || 30;
  this.durationMinutes = duration;

  if (this.scheduledAt) {
    this.scheduledEndAt = new Date(new Date(this.scheduledAt).getTime() + duration * 60 * 1000);
  }

  if (typeof this.amount === 'number' && this.amount > 0) {
    const gross = Math.round(this.amount);
    const feePercent = this.financials?.platformFeePercent ?? 10;
    const feeAmount = Math.round((gross * feePercent) / 100);
    this.financials = {
      grossAmount: gross,
      platformFeePercent: feePercent,
      platformFeeAmount: feeAmount,
      expertNetAmount: gross - feeAmount,
      currency: 'INR',
    };
  }
});

CallRequestSchema.index({ requester: 1 });
CallRequestSchema.index({ recipient: 1 });
CallRequestSchema.index({ requester: 1, recipient: 1 });
CallRequestSchema.index({ recipient: 1, status: 1, scheduledAt: 1, scheduledEndAt: 1 });

// Self-destruct TTL index for unpaid 10-minute holds
CallRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

CallRequestSchema.index(
  { recipient: 1, scheduledAt: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['holding', 'accepted'] } },
  }
);

module.exports = mongoose.model('CallRequest', CallRequestSchema);