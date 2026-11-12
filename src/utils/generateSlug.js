// backend/src/utils/generateSlug.js
const crypto = require('crypto');
const User = require('../models/User');

const generateUniqueSlug = async (name) => {
  const rawName = typeof name === 'string' ? name : '';
  let baseSlug = rawName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 40);

  if (!baseSlug) {
    baseSlug = 'member';
  }

  let slug = baseSlug;
  let counter = 1;

  while (counter <= 3) {
    const exists = await User.exists({ slug });
    if (!exists) return slug;
    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  // If >3 collisions exist, append a cryptographic 6-char hex suffix for O(1) resolution
  const randomSuffix = crypto.randomBytes(3).toString('hex');
  return `${baseSlug}-${randomSuffix}`;
};

module.exports = generateUniqueSlug;