// backend/src/utils/encryption.js
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;

const getKey = () => {
  const rawKey = process.env.ZOOM_TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;

  if (!rawKey) {
    throw new Error('Encryption key is not configured in environment variables');
  }

  // If rawKey is already a valid 64-character hex string (32 bytes), use it directly
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    return Buffer.from(rawKey, 'hex');
  }

  // Otherwise derive a deterministic 32-byte key via SHA-256 so AES-256 never crashes
  return crypto.createHash('sha256').update(String(rawKey)).digest();
};

const encrypt = (text) => {
  if (!text || typeof text !== 'string') return text;

  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTE_LENGTH,
  });

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
};

const decrypt = (encryptedText) => {
  if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;

  const key = getKey();
  const parts = encryptedText.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;

  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('Invalid encrypted token components');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  if (iv.length !== IV_BYTE_LENGTH || authTag.length !== AUTH_TAG_BYTE_LENGTH) {
    throw new Error('Security Alert: Invalid IV or GCM AuthTag length');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_BYTE_LENGTH,
  });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
};

module.exports = {
  encrypt,
  decrypt,
};