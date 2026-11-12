// backend/src/controllers/ideaController.js
const mongoose = require('mongoose');
const Idea = require('../models/Idea');
const Profile = require('../models/Profile');

const escapeRegex = (str) => {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const VALID_JOB_TYPES = ['Full-Time', 'Internship', 'Referral', 'Contract', 'Freelance'];
const VALID_WORK_MODES = ['Remote', 'Hybrid', 'On-Site'];
const VALID_CATEGORIES = [
  'Technology',
  'Engineering',
  'Design',
  'Business',
  'Startup',
  'Marketing',
  'Finance',
  'Career',
  'Other',
];

// Blocked URL shorteners & high-risk TLDs commonly used in fake/phishing links
const BLOCKED_SHORTENERS = [
  'bit.ly',
  'tinyurl.com',
  'cutt.ly',
  'rb.gy',
  'shorturl.at',
  'is.gd',
  't.co',
  'ow.ly',
  'tiny.cc',
  'bit.do',
  'adf.ly',
];
const SUSPICIOUS_TLDS = ['.tk', '.ml', '.ga', '.cf', '.gq', '.zip', '.mov', '.top', '.xyz'];

const validateJobApplicationLink = (rawLink) => {
  if (!rawLink || typeof rawLink !== 'string' || !rawLink.trim()) {
    return { isValid: false, error: 'Job application link is required.' };
  }

  const trimmed = rawLink.trim();

  // Block dangerous schemes
  if (/^(javascript:|data:|vbscript:|file:|http:\/\/)/i.test(trimmed)) {
    return {
      isValid: false,
      error: 'Insecure link detected. Only secure https:// job links are allowed.',
    };
  }

  const normalizedUrl = /^https:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed;
  try {
    parsed = new URL(normalizedUrl);
  } catch (e) {
    return { isValid: false, error: 'Invalid URL format. Example: https://company.com/careers' };
  }

  if (parsed.protocol !== 'https:') {
    return { isValid: false, error: 'Link must use secure HTTPS protocol (https://).' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Reject raw IP addresses (e.g. https://192.168.1.1/login)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname === 'localhost') {
    return {
      isValid: false,
      error: 'Raw IP addresses or localhost links are blocked for security.',
    };
  }

  // Require valid domain dot structure
  if (!hostname.includes('.') || hostname.startsWith('.') || hostname.endsWith('.')) {
    return { isValid: false, error: 'Please enter a valid company domain name.' };
  }

  // Block masked URL shorteners
  if (BLOCKED_SHORTENERS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    return {
      isValid: false,
      error: 'Shortened links (bit.ly, tinyurl, etc.) are blocked. Please paste the direct job URL.',
    };
  }

  // Block high-risk phishing TLDs
  if (SUSPICIOUS_TLDS.some((tld) => hostname.endsWith(tld))) {
    return {
      isValid: false,
      error: 'This domain extension is flagged as unsafe. Please use an official career/company link.',
    };
  }

  return { isValid: true, cleanUrl: parsed.toString() };
};

const countWords = (text) => {
  if (!text || typeof text !== 'string') return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
};

// @desc    Create a new Job Post (STRICTLY VERIFIED EXPERTS ONLY)
// @route   POST /api/v1/ideas
exports.createIdea = async (req, res) => {
  try {
    const userProfile = await Profile.findOne({ user: req.user._id }).populate('user', 'name');

    if (
      !userProfile ||
      userProfile.role !== 'expert' ||
      userProfile.mentorApplicationStatus !== 'approved'
    ) {
      return res.status(403).json({
        success: false,
        error: 'Access Denied: Only verified mentors can post job opportunities.',
      });
    }

    let {
      jobTitle,
      companyName,
      jobType,
      workMode,
      location,
      stipendOrSalary,
      experienceRequired,
      skillsRequired,
      applyLink,
      category,
      message,
    } = req.body;

    const cleanTitle = typeof jobTitle === 'string' ? jobTitle.trim().slice(0, 140) : '';
    const cleanCompany =
      typeof companyName === 'string' && companyName.trim()
        ? companyName.trim().slice(0, 120)
        : userProfile?.companyName || '';
    const cleanSalary =
      typeof stipendOrSalary === 'string' ? stipendOrSalary.trim().slice(0, 100) : '';
    const cleanLocation =
      typeof location === 'string' && location.trim()
        ? location.trim().slice(0, 120)
        : userProfile?.city || 'India';
    const cleanExperience =
      typeof experienceRequired === 'string' && experienceRequired.trim()
        ? experienceRequired.trim().slice(0, 100)
        : 'Fresher / Open';
    const cleanMessage = typeof message === 'string' ? message.trim() : '';

    if (!cleanTitle) {
      return res.status(400).json({ success: false, error: 'Job Role / Title is required.' });
    }
    if (!cleanCompany) {
      return res.status(400).json({ success: false, error: 'Company Name is required.' });
    }
    if (!cleanSalary) {
      return res.status(400).json({
        success: false,
        error: 'Salary / Stipend is required (e.g., ₹12 LPA or ₹25,000/month).',
      });
    }
    if (!cleanMessage) {
      return res.status(400).json({ success: false, error: 'Job Description is required.' });
    }

    const wordCount = countWords(cleanMessage);
    if (wordCount > 2000 || cleanMessage.length > 15000) {
      return res.status(400).json({
        success: false,
        error: `Job description exceeds the 2000-word limit (Currently ${wordCount} words).`,
      });
    }

    // Validate job link security
    const linkCheck = validateJobApplicationLink(applyLink);
    if (!linkCheck.isValid) {
      return res.status(400).json({ success: false, error: linkCheck.error });
    }

    // Anti-Spam Rate Limits
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const twentySecondsAgo = new Date(Date.now() - 20 * 1000);

    const recentIdeas = await Idea.collection
      .find({
        authorId: new mongoose.Types.ObjectId(String(req.user._id)),
        createdAt: { $gte: oneDayAgo },
      })
      .sort({ createdAt: -1 })
      .toArray();

    if (recentIdeas.length >= 15) {
      return res.status(429).json({
        success: false,
        error: 'Daily limit reached. You can post up to 15 job opportunities per day.',
      });
    }

    if (recentIdeas.length > 0 && new Date(recentIdeas[0].createdAt) > twentySecondsAgo) {
      return res.status(429).json({
        success: false,
        error: 'Please wait 20 seconds before posting another job.',
      });
    }

    let parsedSkills = [];
    if (Array.isArray(skillsRequired)) {
      parsedSkills = skillsRequired
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 15);
    } else if (typeof skillsRequired === 'string' && skillsRequired.trim() !== '') {
      parsedSkills = skillsRequired
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 15);
    }

    const safeJobType = VALID_JOB_TYPES.includes(jobType) ? jobType : 'Full-Time';
    const safeWorkMode = VALID_WORK_MODES.includes(workMode) ? workMode : 'On-Site';
    const safeCategory = VALID_CATEGORIES.includes(category) ? category : 'Technology';

    const now = new Date();
    const jobDoc = {
      authorId: new mongoose.Types.ObjectId(String(req.user._id)),
      authorName: userProfile?.user?.name || req.user.name || 'Verified Mentor',
      profileImage: userProfile?.profileImage || 'default-avatar.png',
      designation: userProfile?.designation || 'Verified Mentor',
      company: userProfile?.companyName || cleanCompany,
      jobTitle: cleanTitle,
      companyName: cleanCompany,
      jobType: safeJobType,
      workMode: safeWorkMode,
      location: cleanLocation,
      stipendOrSalary: cleanSalary,
      experienceRequired: cleanExperience,
      skillsRequired: parsedSkills,
      applyLink: linkCheck.cleanUrl,
      isLinkVerified: true,
      category: safeCategory,
      message: cleanMessage,
      likesCount: 0,
      likedBy: [],
      createdAt: now,
      updatedAt: now,
    };

    const insertResult = await Idea.collection.insertOne(jobDoc);
    const savedJob = { ...jobDoc, _id: insertResult.insertedId };

    res.status(201).json({ success: true, data: savedJob });
  } catch (error) {
    console.error('Create Job Post Error:', error);
    res.status(500).json({ success: false, error: 'Server Error while posting job.' });
  }
};

// @desc    Update / Edit an Existing Job Post (Author Expert Only)
// @route   PUT /api/v1/ideas/:id
exports.updateIdea = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid job post ID.' });
    }

    const existingJob = await Idea.collection.findOne({
      _id: new mongoose.Types.ObjectId(String(req.params.id)),
    });

    if (!existingJob) {
      return res.status(404).json({ success: false, error: 'Job post not found.' });
    }

    if (String(existingJob.authorId) !== String(req.user._id)) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to edit this job post.',
      });
    }

    let {
      jobTitle,
      companyName,
      jobType,
      workMode,
      location,
      stipendOrSalary,
      experienceRequired,
      skillsRequired,
      applyLink,
      category,
      message,
    } = req.body;

    const cleanTitle = typeof jobTitle === 'string' ? jobTitle.trim().slice(0, 140) : '';
    const cleanCompany = typeof companyName === 'string' ? companyName.trim().slice(0, 120) : '';
    const cleanSalary =
      typeof stipendOrSalary === 'string' ? stipendOrSalary.trim().slice(0, 100) : '';
    const cleanLocation =
      typeof location === 'string' && location.trim() ? location.trim().slice(0, 120) : 'India';
    const cleanExperience =
      typeof experienceRequired === 'string' && experienceRequired.trim()
        ? experienceRequired.trim().slice(0, 100)
        : 'Fresher / Open';
    const cleanMessage = typeof message === 'string' ? message.trim() : '';

    if (!cleanTitle || !cleanCompany || !cleanSalary || !cleanMessage) {
      return res.status(400).json({
        success: false,
        error: 'Job Role, Company Name, Salary/Stipend, and Description are required.',
      });
    }

    const wordCount = countWords(cleanMessage);
    if (wordCount > 2000 || cleanMessage.length > 15000) {
      return res.status(400).json({
        success: false,
        error: `Job description exceeds the 2000-word limit (Currently ${wordCount} words).`,
      });
    }

    const linkCheck = validateJobApplicationLink(applyLink);
    if (!linkCheck.isValid) {
      return res.status(400).json({ success: false, error: linkCheck.error });
    }

    let parsedSkills = [];
    if (Array.isArray(skillsRequired)) {
      parsedSkills = skillsRequired
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 15);
    } else if (typeof skillsRequired === 'string' && skillsRequired.trim() !== '') {
      parsedSkills = skillsRequired
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 15);
    }

    const updateFields = {
      jobTitle: cleanTitle,
      companyName: cleanCompany,
      jobType: VALID_JOB_TYPES.includes(jobType) ? jobType : existingJob.jobType || 'Full-Time',
      workMode: VALID_WORK_MODES.includes(workMode) ? workMode : existingJob.workMode || 'On-Site',
      location: cleanLocation,
      stipendOrSalary: cleanSalary,
      experienceRequired: cleanExperience,
      skillsRequired: parsedSkills,
      applyLink: linkCheck.cleanUrl,
      isLinkVerified: true,
      category: VALID_CATEGORIES.includes(category)
        ? category
        : existingJob.category || 'Technology',
      message: cleanMessage,
      updatedAt: new Date(),
    };

    await Idea.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(req.params.id)) },
      { $set: updateFields }
    );

    const updatedDoc = await Idea.collection.findOne({
      _id: new mongoose.Types.ObjectId(String(req.params.id)),
    });

    res.status(200).json({ success: true, data: updatedDoc });
  } catch (error) {
    console.error('Update Job Post Error:', error);
    res.status(500).json({ success: false, error: 'Server Error while updating job.' });
  }
};

// @desc    Get Jobs Feed (with infinite scroll & filters)
// @route   GET /api/v1/ideas
exports.getFeed = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 15));
    const startIndex = (page - 1) * limit;

    const query = {};
    const filterVal = typeof req.query.category === 'string' ? req.query.category.trim() : '';

    if (filterVal && filterVal !== 'All Ideas' && filterVal !== 'All Jobs') {
      if (VALID_JOB_TYPES.includes(filterVal)) {
        query.jobType = filterVal;
      } else if (VALID_WORK_MODES.includes(filterVal)) {
        query.workMode = filterVal;
      } else {
        query.category = filterVal;
      }
    }

    let sortObj = { createdAt: -1 };
    if (req.query.sort === 'trending') {
      sortObj = { likesCount: -1, createdAt: -1 };
    }

    const ideas = await Idea.collection
      .find(query)
      .sort(sortObj)
      .skip(startIndex)
      .limit(limit)
      .toArray();

    res.status(200).json({ success: true, count: ideas.length, data: ideas });
  } catch (error) {
    console.error('Get Jobs Feed Error:', error);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Toggle Like / Interested on a Job Post
// @route   PUT /api/v1/ideas/:id/like
exports.toggleLike = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid post ID' });
    }

    const idea = await Idea.findById(req.params.id);
    if (!idea) {
      return res.status(404).json({ success: false, error: 'Job post not found' });
    }

    const userIdStr = req.user._id.toString();
    const isLiked = idea.likedBy.some((id) => id.toString() === userIdStr);

    if (isLiked) {
      idea.likedBy = idea.likedBy.filter((id) => id.toString() !== userIdStr);
      idea.likesCount = Math.max(0, (idea.likesCount || 1) - 1);
    } else {
      idea.likedBy.push(req.user._id);
      idea.likesCount = (idea.likesCount || 0) + 1;
    }

    await idea.save();
    res.status(200).json({
      success: true,
      isLiked: !isLiked,
      likesCount: idea.likesCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Search Job Posts
// @route   GET /api/v1/ideas/search?q=keyword
exports.searchIdeas = async (req, res) => {
  try {
    const rawTerm = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!rawTerm) {
      return res.status(200).json({ success: true, data: [] });
    }

    const safeTerm = escapeRegex(rawTerm.slice(0, 80));
    const regex = new RegExp(safeTerm, 'i');

    const ideas = await Idea.collection
      .find({
        $or: [
          { jobTitle: regex },
          { companyName: regex },
          { stipendOrSalary: regex },
          { location: regex },
          { jobType: regex },
          { workMode: regex },
          { skillsRequired: regex },
          { message: regex },
          { authorName: regex },
          { company: regex },
        ],
      })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray();

    res.status(200).json({ success: true, count: ideas.length, data: ideas });
  } catch (error) {
    console.error('Search Jobs Error:', error);
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};

// @desc    Delete a Job Post (Author Only)
// @route   DELETE /api/v1/ideas/:id
exports.deleteIdea = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: 'Invalid ID' });
    }

    const idea = await Idea.findById(req.params.id);
    if (!idea) {
      return res.status(404).json({ success: false, error: 'Job post not found' });
    }

    if (idea.authorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to delete this job post',
      });
    }

    await idea.deleteOne();
    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Server Error' });
  }
};