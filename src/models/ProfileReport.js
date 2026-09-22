const mongoose = require('mongoose');

const ProfileReportSchema = new mongoose.Schema({
  reportedUser: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  reportedBy: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  reason: { 
    type: String, 
    enum: ['Fake Profile', 'Spam or Scam', 'Inappropriate Content', 'Harassment', 'Other'],
    required: true 
  },
  description: { 
    type: String, 
    maxLength: 1000 
  },
  status: { 
    type: String, 
    enum: ['pending', 'reviewed', 'resolved'], 
    default: 'pending' 
  }
}, { timestamps: true });

// Exporting as ProfileReport to avoid your existing Report.js file
module.exports = mongoose.model('ProfileReport', ProfileReportSchema);