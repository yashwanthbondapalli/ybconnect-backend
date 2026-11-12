// backend/src/utils/generateToken.js
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const generateAccessToken = (id) => {
  if (!process.env.JWT_SECRET) {
    console.error('CRITICAL: JWT_SECRET is missing in .env');
    process.exit(1);
  }

  return jwt.sign(
    {
      id: String(id),
      type: 'access',
      jti: crypto.randomUUID(),
    },
    process.env.JWT_SECRET,
    {
      expiresIn: '15m',
      algorithm: 'HS256',
    }
  );
};

const generateRefreshToken = (id) => {
  if (!process.env.REFRESH_TOKEN_SECRET) {
    console.error('CRITICAL: REFRESH_TOKEN_SECRET is missing in .env');
    process.exit(1);
  }

  return jwt.sign(
    {
      id: String(id),
      type: 'refresh',
      jti: crypto.randomUUID(),
    },
    process.env.REFRESH_TOKEN_SECRET,
    {
      expiresIn: '30d',
      algorithm: 'HS256',
    }
  );
};

module.exports = { generateAccessToken, generateRefreshToken };