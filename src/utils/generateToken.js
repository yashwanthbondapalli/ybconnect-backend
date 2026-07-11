const jwt = require('jsonwebtoken');

const generateToken = (id) => {
  // --- ENTERPRISE FIX START ---
  if (!process.env.JWT_SECRET) {
    console.error('FATAL ERROR: JWT_SECRET is not defined in environment variables.');
    // Crashing the process is safer than generating a compromised token
    process.exit(1); 
  }
  // --- ENTERPRISE FIX END ---

  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: '30d',
  });
};

module.exports = generateToken;