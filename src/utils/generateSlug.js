const User = require('../models/User'); // Adjust path to your User model

// 🚨 Add this utility function
const generateUniqueSlug = async (name) => {
  // 1. Clean the name: "Namala Sowbhagya Lakshmi" -> "namala-sowbhagya-lakshmi"
  let baseSlug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-') // Replace spaces and special chars with hyphens
    .replace(/(^-|-$)+/g, '');   // Remove hyphens from start/end

  // 2. Check if this slug already exists in your database
  let slug = baseSlug;
  let slugExists = await User.findOne({ slug });
  let counter = 1;

  // 3. If it exists, add a number to the end (e.g., namala-sowbhagya-lakshmi-1)
  while (slugExists) {
    slug = `${baseSlug}-${counter}`;
    slugExists = await User.findOne({ slug });
    counter++;
  }

  return slug;
};

module.exports = generateUniqueSlug;