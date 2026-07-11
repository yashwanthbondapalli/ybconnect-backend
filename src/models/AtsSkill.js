const mongoose = require('mongoose');

const AtsSkillSchema = new mongoose.Schema({
  // The official name we show the user (e.g., "Node.js")
  canonicalName: { 
    type: String, 
    required: true, 
    unique: true, 
    trim: true 
  },
  // All the weird ways people write it (e.g., ["node", "nodejs", "node js"])
  aliases: [{ 
    type: String, 
    lowercase: true,
    trim: true 
  }],
  // Useful for grouping (e.g., "Backend", "Frontend", "Cloud")
  category: { 
    type: String, 
    trim: true 
  }
});



module.exports = mongoose.model('AtsSkill', AtsSkillSchema);