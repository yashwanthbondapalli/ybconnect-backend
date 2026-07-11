const mongoose = require('mongoose');

const AtsReviewLogSchema = new mongoose.Schema({
  // Links to your existing users collection
  user: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    required: true 
  },
  targetJobTitle: { 
    type: String, 
    required: true 
  },
  atsScore: { 
    type: Number, 
    required: true 
  },
  // We can dump the entire output JSON here so the user can view past reviews!
  resultsJson: { 
    type: Object, 
    required: true 
  }
}, { timestamps: true });

module.exports = mongoose.model('AtsReviewLog', AtsReviewLogSchema);