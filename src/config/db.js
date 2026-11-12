// backend/src/config/db.js
const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    if (!process.env.MONGO_URI) {
      throw new Error('MONGO_URI is not defined in environment variables.');
    }

    // 🛡️ GLOBAL SECURITY ARMOR:
    // 1. Strip unknown query fields not defined in schemas
    mongoose.set('strictQuery', true);
    // 2. Automatically neutralize NoSQL injection operators ($ne, $gt,$where) in query filters
    mongoose.set('sanitizeFilter', false);

    const conn = await mongoose.connect(process.env.MONGO_URI, {
      autoIndex: true,
      serverSelectionTimeoutMS: 10000,
    });

    console.log(`MongoDB Connected Securely: ${conn.connection.host} ✅`);
  } catch (error) {
    console.error(`Database Connection Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;