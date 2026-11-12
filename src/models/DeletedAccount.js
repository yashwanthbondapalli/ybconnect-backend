// backend/src/models/DeletedAccount.js
const mongoose = require('mongoose');

const DeletedAccountSchema = new mongoose.Schema({
  originalUserId: { type: String, required: true, trim: true, maxLength: 64, index: true },
  email: { type: String, trim: true, lowercase: true, maxLength: 254 },
  name: { type: String, trim: true, maxLength: 100 },
  role: { type: String, trim: true, maxLength: 30 },
  reasonForLeaving: {
    type: String,
    trim: true,
    maxLength: 500,
    default: 'No reason provided',
  },
  deletedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('DeletedAccount', DeletedAccountSchema);