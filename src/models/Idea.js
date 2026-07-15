const mongoose = require('mongoose');

const IdeaSchema = new mongoose.Schema({
  authorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  authorName: { type: String, required: true },
  profileImage: { type: String, default: 'default-avatar.png' },
  designation: { type: String, default: '' },
  company: { type: String, default: '' },
  
  category: {
    type: String,
    enum: ['Technology', 'Business', 'Career', 'Startup', 'Design', 'Marketing', 'Finance', 'Engineering', 'Other'],
    default: 'Other'
  },
  
  message: {
    type: String,
    required: [true, 'Idea message cannot be empty'],
    maxlength: [2000, 'Idea cannot exceed 2000 characters'],
    trim: true // Automatically strips whitespace from start and end
  },

  likesCount: { type: Number, default: 0 },
  
  likedBy: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
}, { 
  timestamps: true // Automatically creates createdAt and updatedAt
});

// Indexes for ultra-fast feed loading and searching
IdeaSchema.index({ createdAt: -1 }); 
IdeaSchema.index({ category: 1, createdAt: -1 });
IdeaSchema.index({ likesCount: -1 });

module.exports = mongoose.model('Idea', IdeaSchema);