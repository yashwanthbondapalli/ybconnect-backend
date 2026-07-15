const jwt = require('jsonwebtoken');

const generateAccessToken = (id) => {
  if (!process.env.JWT_SECRET) process.exit(1);
  // Short lifespan: 15 minutes
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '15m' });
};

const generateRefreshToken = (id) => {
  if (!process.env.REFRESH_TOKEN_SECRET) process.exit(1);
  // Long lifespan: 30 days
  return jwt.sign({ id }, process.env.REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
};

module.exports = { generateAccessToken, generateRefreshToken };