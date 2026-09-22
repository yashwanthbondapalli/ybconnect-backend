const mongoose = require('mongoose');

const DeletedAccountSchema = new mongoose.Schema({
  originalUserId: { type: String },
  email: { type: String },
  name: { type: String },
  role: { type: String },
  reasonForLeaving: { type: String, default: 'No reason provided' },
  deletedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('DeletedAccount', DeletedAccountSchema);