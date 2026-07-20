const mongoose = require('mongoose');

const ReportSchema = new mongoose.Schema({
  reporter: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  reportedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  
  // The exact post/comment they are reporting
  contentId: { type: mongoose.Schema.Types.ObjectId, required: true }, 
  contentType: { type: String, enum: ['idea', 'comment', 'message', 'profile'], required: true },
  
  // A snapshot of the bad text (in case the user deletes it later, you still have proof)
  reportedContentSnapshot: { type: String }, 
  
  // The category they selected
  reasonCategory: {
    type: String,
    enum: [
      'harassment', 'fraud_scam', 'spam', 'misinformation',
      'hate_speech', 'threats_violence', 'self_harm',
      'extremist', 'sexual_content', 'fake_account',
      'child_exploitation', 'restricted_goods', 'other'
    ],
    required: true
  },
  
  // Their typed explanation
  userComment: { type: String, maxLength: 1000 },
  
  // Admin tracking tools
  status: { type: String, enum: ['pending', 'under_review', 'resolved', 'dismissed'], default: 'pending' },
  actionTaken: { type: String, enum: ['none', 'content_removed', 'user_warned', 'user_banned'], default: 'none' },
  moderatorNotes: { type: String }
}, { timestamps: true });

// 🚨 ANTI-SPAM LOCK: Prevents one user from reporting the same post multiple times
ReportSchema.index({ reporter: 1, contentId: 1 }, { unique: true });

module.exports = mongoose.model('Report', ReportSchema);