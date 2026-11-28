// backend/src/controllers/profileController.js
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const Profile = require('../models/Profile');
const User = require('../models/User');
const CallRequest = require('../models/CallRequest');
const generateUniqueSlug = require('../utils/generateSlug');
const Idea = require('../models/Idea');
const sendEmail = require('../utils/emailHelper');
const sendPushNotification = require('../utils/pushHelper');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const PRICING_FLOORS = {
  10: 10,
  20: 299,
  30: 499,
  40: 599,
  60: 999,
};

const DEFAULT_TIERS = [10, 20, 30, 40, 60].map((d) => ({
  duration: d,
  price: PRICING_FLOORS[d],
  minPrice: PRICING_FLOORS[d],
  isEnabled: true,
}));

// Never leak private bank details, personal phone numbers, or admin interview links on public views
const PUBLIC_PROFILE_EXCLUSIONS =
  '-accountNumber -ifscCode -razorpayAccountId -phoneNumber -zoomCredentials -mentorApplication';

const escapeRegex = (str) => {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const safeJsonParse = (val, fallback) => {
  if (typeof val !== 'string') return val !== undefined ? val : fallback;
  try {
    return JSON.parse(val);
  } catch (e) {
    return fallback;
  }
};

const sanitizeString = (val, maxLen = 300) => {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
};

const sanitizeStringArray = (val, maxItems = 25, maxItemLen = 80) => {
  const rawList = Array.isArray(val)
    ? val
    : typeof val === 'string'
    ? val.split(',')
    : [];

  const seen = new Set();
  const cleaned = [];

  for (const item of rawList) {
    const str = String(item || '').trim().slice(0, maxItemLen);
    if (!str) continue;
    const key = str.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(str);
    if (cleaned.length >= maxItems) break;
  }

  return cleaned;
};

// Extracts Cloudinary public_id from a secure_url (e.g. "yb_portfolio/project_123_456")
const extractCloudinaryPublicId = (imageUrl) => {
  if (typeof imageUrl !== 'string' || !imageUrl.includes('res.cloudinary.com')) {
    return null;
  }
  const cleanUrl = imageUrl.split('?')[0];
  const match = cleanUrl.match(/\/upload\/(?:v\d+\/)?(.+?)\.[a-zA-Z0-9]+$/);
  return match ? match[1] : null;
};

const destroyCloudinaryAsset = async (publicId) => {
  if (!publicId || !process.env.CLOUDINARY_API_SECRET) return;
  try {
    await cloudinary.uploader.destroy(publicId, { invalidate: true });
  } catch (err) {
    console.error(`Cloudinary destroy warning (${publicId}):`, err.message);
  }
};

const normalizeSessionPricing = (rawPricing, fallbackRate) => {
  if (!Array.isArray(rawPricing) || rawPricing.length === 0) {
    return DEFAULT_TIERS.map((tier) => {
      if (tier.duration === 30 && Number(fallbackRate) >= tier.minPrice) {
        return { ...tier, price: Math.round(Number(fallbackRate)) };
      }
      return { ...tier };
    });
  }

  const normalized = [10, 20, 30, 40, 60].map((duration) => {
    const minFloor = PRICING_FLOORS[duration];
    const match = rawPricing.find((item) => Number(item.duration) === duration);
    if (!match) {
      return {
        duration,
        price: minFloor,
        minPrice: minFloor,
        isEnabled: true,
      };
    }

    const enteredPrice = Math.round(Number(match.price) || minFloor);
    if (enteredPrice < minFloor) {
      const err = new Error(
        `Price for a ${duration}-minute session cannot be less than ₹${minFloor}.`
      );
      err.statusCode = 400;
      throw err;
    }

    return {
      duration,
      price: enteredPrice,
      minPrice: minFloor,
      isEnabled: match.isEnabled !== false,
    };
  });

  if (!normalized.some((t) => t.isEnabled)) {
    const err = new Error('Please keep at least one session duration enabled.');
    err.statusCode = 400;
    throw err;
  }

  return normalized;
};

// @desc    Get current logged-in user's own profile (Auto-marks Experts Online on App Open)
// @route   GET /api/v1/profile/me
exports.getCurrentUserProfile = async (req, res, next) => {
  try {
    const profile = await Profile.findOne({ user: req.user.id }).populate('user', [
      'name',
      'email',
      'slug',
      'phoneNumber',
      'role',
    ]);

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'There is no profile for this user',
      });
    }

    // Automatically mark any Expert online when they open the app
    if (profile.role === 'expert') {
      const now = new Date();
      profile.isLive = true;
      profile.liveConnectionStatus = 'available';
      profile.lastActiveAt = now;
      await Profile.updateOne(
        { _id: profile._id },
        {
          $set: {
            isLive: true,
            liveConnectionStatus: 'available',
            lastActiveAt: now,
          },
        }
      );
    }

    res.status(200).json({
      success: true,
      data: profile,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Submit Mentor Verification & Interview Request
// @route   POST /api/v1/profile/mentor-application
exports.submitMentorApplication = async (req, res, next) => {
  try {
    const {
      fullName,
      phoneNumber,
      designation,
      companyName,
      category,
      yearsOfExperience,
      linkedinUrl,
      portfolioUrl,
      proofLinks,
      preferredInterviewTime,
      whyMentor,
    } = req.body;

    if (
      typeof fullName !== 'string' ||
      !fullName.trim() ||
      typeof phoneNumber !== 'string' ||
      !phoneNumber.trim() ||
      typeof designation !== 'string' ||
      !designation.trim() ||
      typeof companyName !== 'string' ||
      !companyName.trim() ||
      typeof category !== 'string' ||
      !category.trim() ||
      typeof linkedinUrl !== 'string' ||
      !linkedinUrl.trim() ||
      typeof whyMentor !== 'string' ||
      !whyMentor.trim()
    ) {
      return res.status(400).json({
        success: false,
        error:
          'Please fill in all required verification fields (Name, Phone, Role, Company, Domain, LinkedIn URL, and Mentorship Pitch).',
      });
    }

    const existingProfile = await Profile.findOne({ user: req.user.id });

    if (existingProfile?.mentorApplicationStatus === 'approved') {
      return res.status(400).json({
        success: false,
        error: 'Your mentor profile is already verified and unlocked!',
      });
    }

    const cleanName = fullName.trim().slice(0, 80);
    const currentUser = await User.findById(req.user.id);
    if (currentUser && (currentUser.name !== cleanName || !currentUser.slug)) {
      const newSlug = await generateUniqueSlug(cleanName);
      await User.findByIdAndUpdate(req.user.id, {
        name: cleanName,
        slug: newSlug,
      });
    }

    const applicationPayload = {
      fullName: cleanName,
      phoneNumber: phoneNumber.trim().slice(0, 15),
      designation: designation.trim().slice(0, 100),
      companyName: companyName.trim().slice(0, 100),
      category: category.trim().slice(0, 80),
      yearsOfExperience: Math.max(0, Math.min(60, Number(yearsOfExperience) || 0)),
      linkedinUrl: linkedinUrl.trim().slice(0, 300),
      portfolioUrl:
        typeof portfolioUrl === 'string' ? portfolioUrl.trim().slice(0, 300) : '',
      preferredInterviewTime:
        typeof preferredInterviewTime === 'string' && preferredInterviewTime.trim()
          ? preferredInterviewTime.trim().slice(0, 120)
          : 'Flexible (IST)',
      whyMentor: whyMentor.trim().slice(0, 1000),
      submittedAt: new Date(),
    };

    const setPayload = {
      phoneNumber: applicationPayload.phoneNumber,
      designation: applicationPayload.designation,
      companyName: applicationPayload.companyName,
      category: applicationPayload.category,
      yearsOfExperience: applicationPayload.yearsOfExperience,
      'socialLinks.linkedin': applicationPayload.linkedinUrl,
      mentorApplicationStatus: 'pending',
      mentorApplication: applicationPayload,
    };

    if (applicationPayload.portfolioUrl) {
      setPayload['socialLinks.website'] = applicationPayload.portfolioUrl;
    }
    if (proofLinks && typeof proofLinks === 'object') {
      if (typeof proofLinks.youtube === 'string' && proofLinks.youtube.trim()) {
        setPayload['socialLinks.youtube'] = proofLinks.youtube.trim().slice(0, 300);
      }
      if (typeof proofLinks.instagram === 'string' && proofLinks.instagram.trim()) {
        setPayload['socialLinks.instagram'] = proofLinks.instagram.trim().slice(0, 300);
      }
      if (typeof proofLinks.xUrl === 'string' && proofLinks.xUrl.trim()) {
        setPayload['socialLinks.xUrl'] = proofLinks.xUrl.trim().slice(0, 300);
      }
    }

    const updatedProfile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      {
        $set: setPayload,
        $setOnInsert: {
          role: 'student',
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).populate('user', 'name email slug phoneNumber');

    try {
      const adminEmail =
        process.env.ADMIN_EMAIL || process.env.EMAIL_USER || 'ybconnect10@gmail.com';

      await Promise.all([
        sendEmail({
          email: currentUser.email,
          subject: '🛡️ YB Connect Mentor Application Received - Next Step: 1:1 Interview',
          message: `Hi ${cleanName},\n\nThank you for applying to become a Verified Mentor on YB Connect!\n\nWe have received your application:\n- Role: ${applicationPayload.designation} at ${applicationPayload.companyName}\n- Domain: ${applicationPayload.category} (${applicationPayload.yearsOfExperience} yrs exp)\n- Preferred Interview Window: ${applicationPayload.preferredInterviewTime}\n\nNext Step:\nOur verification team will review your LinkedIn and credentials and reach out to you on ${applicationPayload.phoneNumber} / email to conduct a quick 10-minute verification interview. Once qualified, your "I Mentor" studio will unlock automatically in the app!\n\nWarm regards,\nYB Connect Verification Team`,
        }),
        sendEmail({
          email: adminEmail,
          subject: `🚀 New Mentor Verification Application: ${cleanName} (${applicationPayload.companyName})`,
          message: `New Mentor Application Submitted!\n\n- User ID: ${req.user.id}\n- Name: ${cleanName}\n- Email: ${currentUser.email}\n- Phone: ${applicationPayload.phoneNumber}\n- Role: ${applicationPayload.designation} @ ${applicationPayload.companyName}\n- Domain: ${applicationPayload.category}\n- Experience: ${applicationPayload.yearsOfExperience} years\n- LinkedIn: ${applicationPayload.linkedinUrl}\n- Portfolio: ${applicationPayload.portfolioUrl || 'N/A'}\n- YouTube: ${proofLinks?.youtube || 'N/A'}\n- Instagram: ${proofLinks?.instagram || 'N/A'}\n- X / Twitter: ${proofLinks?.xUrl || 'N/A'}\n- Preferred Interview Window: ${applicationPayload.preferredInterviewTime}\n- Pitch: ${applicationPayload.whyMentor}`,
        }),
      ]);
    } catch (emailErr) {
      console.error('Mentor application email warning:', emailErr.message);
    }

    return res.status(200).json({
      success: true,
      message:
        'Application submitted! Our team will verify your details and schedule your interview.',
      data: updatedProfile,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Admin Review Endpoint to Schedule Interview or Approve Mentor
// @route   PUT /api/v1/profile/mentor-application/:userId/review
exports.reviewMentorApplication = async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, error: 'Invalid userId.' });
    }

    const { status, adminNotes, interviewScheduledAt, interviewLink } = req.body;

    if (!['pending', 'interview_scheduled', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status. Use pending, interview_scheduled, approved, or rejected.',
      });
    }

    const updateFields = {
      mentorApplicationStatus: status,
      'mentorApplication.reviewedAt': new Date(),
    };

    if (typeof adminNotes === 'string') {
      updateFields['mentorApplication.adminNotes'] = adminNotes.trim().slice(0, 500);
    }
    if (typeof interviewScheduledAt === 'string') {
      updateFields['mentorApplication.interviewScheduledAt'] = interviewScheduledAt
        .trim()
        .slice(0, 120);
    }
    if (typeof interviewLink === 'string') {
      updateFields['mentorApplication.interviewLink'] = interviewLink.trim().slice(0, 300);
    }

    const profile = await Profile.findOneAndUpdate(
      { user: userId },
      { $set: updateFields },
      { new: true }
    ).populate('user', 'name email slug');

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Applicant profile not found.' });
    }

    try {
      const candidateName = profile.user?.name || 'Mentor Candidate';
      const candidateEmail = profile.user?.email;

      if (status === 'interview_scheduled') {
        await Promise.all([
          sendPushNotification(
            userId,
            '📅 Mentor Interview Scheduled!',
            `Your YB Connect verification interview is scheduled${
              interviewScheduledAt ? ` for ${interviewScheduledAt}` : ''
            }. Open Profile Studio for details!`
          ),
          candidateEmail &&
            sendEmail({
              email: candidateEmail,
              subject: '📅 Your YB Connect Mentor Verification Interview is Scheduled!',
              message: `Hi ${candidateName},\n\nYour profile passed our initial screening! We have scheduled your 1:1 Mentor Verification Interview.\n\n- Time: ${
                interviewScheduledAt || 'As coordinated with our team'
              }\n${interviewLink ? `- Meeting Link: ${interviewLink}\n` : ''}${
                adminNotes ? `- Note from Team: ${adminNotes}\n` : ''
              }\nOnce the interview is completed, we will unlock your Mentor Studio inside the YB Connect app.\n\nBest regards,\nYB Connect Team`,
            }),
        ]);
      } else if (status === 'approved') {
        await Promise.all([
          sendPushNotification(
            userId,
            '🎉 Mentor Studio Unlocked!',
            'Congratulations! You passed the YB Connect verification interview. You can now publish your Mentor profile!'
          ),
          candidateEmail &&
            sendEmail({
              email: candidateEmail,
              subject: '🎉 Congratulations! Your YB Connect Mentor Studio is Now Unlocked',
              message: `Hi ${candidateName},\n\nCongratulations on qualifying through our Mentor Verification Interview!\n\nYour "I Mentor (Expert)" studio is now 100% UNLOCKED in the YB Connect app.\n\nWelcome to the YB Connect Verified Mentor network!\n\nWarm regards,\nYB Connect Team`,
            }),
        ]);
      } else if (status === 'rejected') {
        await Promise.all([
          sendPushNotification(
            userId,
            'Update on Your Mentor Application',
            'Please check Profile Studio for feedback on your mentor verification request.'
          ),
          candidateEmail &&
            sendEmail({
              email: candidateEmail,
              subject: 'Update on Your YB Connect Mentor Application',
              message: `Hi ${candidateName},\n\nThank you for taking the time to apply as a mentor on YB Connect.\n\nAt this stage, we are unable to approve your mentor profile.${
                adminNotes ? `\n\nFeedback from our team: ${adminNotes}` : ''
              }\n\nYou can update your details and re-apply from Profile Studio whenever you are ready.\n\nBest regards,\nYB Connect Team`,
            }),
        ]);
      }
    } catch (notifyErr) {
      console.error('Review notification error:', notifyErr.message);
    }

    return res.status(200).json({
      success: true,
      message: `Mentor application status updated to "${status}".`,
      data: profile,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create or Update Profile (Universal Tier A + Tier B + Cloudinary Cleanup)
// @route   POST /api/v1/profile/me
exports.upsertProfile = async (req, res, next) => {
  try {
    const {
      role,
      yearOfStudy,
      university,
      major,
      minor,
      learnerStage,
      learningGoals,
      studentLookingFor,
      techInterests,
      techSkills,
      softSkills,
      studentProjects,
      internships,
      certifications,
      leadership,
      interests,
      name,
      phoneNumber,
      designation,
      companyName,
      shortDescription,
      whyBookMe,
      workType,
      availabilityTag,
      targetAudience,
      helpTopics,
      sessionPrepNote,
      category,
      city,
      bio,
      skills,
      industries,
      experience,
      servicesOffered,
      portfolio,
      availability,
      scheduleRules,
      sessionPricing,
      yearsOfExperience,
      languages,
      achievements,
      hourlyRate,
      profileImage,
      socialLinks,
    } = req.body;

    if (typeof name === 'string' && name.trim() !== '') {
      const cleanName = name.trim().slice(0, 80);
      const currentUser = await User.findById(req.user.id);

      if (currentUser && (currentUser.name !== cleanName || !currentUser.slug)) {
        const newSlug = await generateUniqueSlug(cleanName);
        await User.findByIdAndUpdate(req.user.id, {
          name: cleanName,
          slug: newSlug,
        });
      }
    }

    const existingProfile = await Profile.findOne({ user: req.user.id });

    // Security Gate: Only allow publishing as 'expert' if mentorApplicationStatus === 'approved'
    const requestedRole = role || existingProfile?.role || 'student';
    if (requestedRole === 'expert' && existingProfile?.mentorApplicationStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        error:
          'Mentor Verification Required: Please submit your mentor verification request and complete the 1:1 interview before publishing a Mentor profile.',
      });
    }

    const effectiveRole =
      existingProfile?.mentorApplicationStatus === 'approved' ? requestedRole : 'student';

    let validatedPricing = existingProfile?.sessionPricing || DEFAULT_TIERS;
    let derivedBaseRate = Number(hourlyRate) || existingProfile?.hourlyRate || 499;

    if (effectiveRole === 'expert') {
      const parsedPricing = safeJsonParse(sessionPricing, []);
      validatedPricing = normalizeSessionPricing(parsedPricing, hourlyRate);

      const thirtyMinTier = validatedPricing.find((t) => t.duration === 30 && t.isEnabled);
      const lowestEnabledTier = validatedPricing
        .filter((t) => t.isEnabled)
        .sort((a, b) => a.price - b.price)[0];
      derivedBaseRate = thirtyMinTier
        ? thirtyMinTier.price
        : lowestEnabledTier
        ? lowestEnabledTier.price
        : 499;
    }

    // Validate profileImage URL
    let safeProfileImage = existingProfile?.profileImage || 'default-avatar.png';
    if (
      typeof profileImage === 'string' &&
      (profileImage === 'default-avatar.png' || profileImage.startsWith('https://'))
    ) {
      safeProfileImage = profileImage.trim();
    }

    // Build $set safely: only overwrite fields explicitly provided so partial updates never wipe data
    const profileFields = {
      user: req.user.id,
      role: effectiveRole,
      hourlyRate: derivedBaseRate,
      sessionPricing: validatedPricing,
      profileImage: safeProfileImage,
      'zoomCredentials.isConnected': true,
    };

    // Shared & Expert String Fields
    if (designation !== undefined) profileFields.designation = sanitizeString(designation, 100);
    if (companyName !== undefined) profileFields.companyName = sanitizeString(companyName, 100);
    if (shortDescription !== undefined) {
      profileFields.shortDescription = sanitizeString(shortDescription, 150);
    }
    if (whyBookMe !== undefined) profileFields.whyBookMe = sanitizeString(whyBookMe, 800);
    if (workType !== undefined) profileFields.workType = sanitizeString(workType, 60);
    if (availabilityTag !== undefined) {
      profileFields.availabilityTag = sanitizeString(availabilityTag, 60);
    }
    if (sessionPrepNote !== undefined) {
      profileFields.sessionPrepNote = sanitizeString(sessionPrepNote, 400);
    }
    if (category !== undefined) profileFields.category = sanitizeString(category, 80);
    if (city !== undefined) profileFields.city = sanitizeString(city, 80);
    if (bio !== undefined) profileFields.bio = sanitizeString(bio, 800);
    if (achievements !== undefined) profileFields.achievements = sanitizeString(achievements, 1500);

    if (yearsOfExperience !== undefined && yearsOfExperience !== '') {
      profileFields.yearsOfExperience = Math.max(0, Math.min(60, Number(yearsOfExperience) || 0));
    }

    // Shared Education & Credentials (Now saved for both Experts & Learners)
    if (university !== undefined) profileFields.university = sanitizeString(university, 140);
    if (major !== undefined) profileFields.major = sanitizeString(major, 120);
    if (minor !== undefined) profileFields.minor = sanitizeString(minor, 120);
    if (yearOfStudy !== undefined) profileFields.yearOfStudy = sanitizeString(yearOfStudy, 40);
    if (certifications !== undefined) {
      profileFields.certifications = sanitizeString(certifications, 2000);
    }

    // Learner / Student Fields (Universal)
    if (learnerStage !== undefined) profileFields.learnerStage = sanitizeString(learnerStage, 60);
    if (learningGoals !== undefined) {
      profileFields.learningGoals = sanitizeString(learningGoals, 400);
    }
    if (studentLookingFor !== undefined) {
      profileFields.studentLookingFor = sanitizeString(studentLookingFor, 800);
    }
    if (techInterests !== undefined) {
      profileFields.techInterests = sanitizeString(techInterests, 500);
    }
    if (studentProjects !== undefined) {
      profileFields.studentProjects = sanitizeString(studentProjects, 2000);
    }
    if (internships !== undefined) profileFields.internships = sanitizeString(internships, 2000);
    if (leadership !== undefined) profileFields.leadership = sanitizeString(leadership, 2000);

    if (typeof phoneNumber === 'string' && phoneNumber.trim() !== '') {
      profileFields.phoneNumber = phoneNumber.trim().slice(0, 15);
    }
    if (availability && typeof availability === 'object') {
      profileFields.availability = availability;
    }

    if (scheduleRules) {
      const parsedRules = safeJsonParse(scheduleRules, {});

      const cleanDays = Array.isArray(parsedRules.days)
        ? parsedRules.days
            .map((d) => ({
              dayOfWeek: Number(d.dayOfWeek),
              timeWindows: Array.isArray(d.timeWindows)
                ? d.timeWindows.filter((w) => w && w.start && w.end && w.start < w.end)
                : [],
            }))
            .filter((d) => !isNaN(d.dayOfWeek) && d.timeWindows.length > 0)
        : [];

      profileFields.scheduleRules = {
        timezone: parsedRules.timezone || 'Asia/Kolkata',
        scheduleMode: parsedRules.scheduleMode || 'uniform',
        sessionDuration: Number(parsedRules.sessionDuration) || 30,
        bufferDuration: Math.max(0, Number(parsedRules.bufferDuration) || 0),
        noticePeriodHours:
          parsedRules.noticePeriodHours !== undefined
            ? Number(parsedRules.noticePeriodHours)
            : 0.166,
        days: cleanDays,
        dateOverrides: Array.isArray(parsedRules.dateOverrides) ? parsedRules.dateOverrides : [],
        blackoutDates: Array.isArray(parsedRules.blackoutDates) ? parsedRules.blackoutDates : [],
      };
    }

    // Array / Chip Fields (Deduplicated & Length-Capped)
    if (skills !== undefined) profileFields.skills = sanitizeStringArray(skills, 25, 50);
    if (techSkills !== undefined) {
      profileFields.techSkills = sanitizeStringArray(techSkills, 25, 50);
    }
    if (softSkills !== undefined) {
      profileFields.softSkills = sanitizeStringArray(softSkills, 20, 50);
    }
    if (languages !== undefined) profileFields.languages = sanitizeStringArray(languages, 15, 40);
    if (industries !== undefined) {
      profileFields.industries = sanitizeStringArray(industries, 20, 50);
    }
    if (interests !== undefined) profileFields.interests = sanitizeStringArray(interests, 20, 50);
    if (targetAudience !== undefined) {
      profileFields.targetAudience = sanitizeStringArray(targetAudience, 10, 50);
    }
    if (helpTopics !== undefined) {
      profileFields.helpTopics = sanitizeStringArray(helpTopics, 8, 80);
    }

    if (experience !== undefined) {
      profileFields.experience = safeJsonParse(experience, []);
    }
    if (servicesOffered !== undefined) {
      profileFields.servicesOffered = safeJsonParse(servicesOffered, []);
    }
    if (portfolio !== undefined) {
      profileFields.portfolio = safeJsonParse(portfolio, []);
    }

    // Clean Social & Proof Links (Includes YouTube; keeps GitHub/Coding link for Learners)
    if (socialLinks && typeof socialLinks === 'object') {
      const existingLinks = existingProfile?.socialLinks || {};
      profileFields.socialLinks = {
        linkedin:
          socialLinks.linkedin !== undefined
            ? sanitizeString(socialLinks.linkedin, 300)
            : existingLinks.linkedin || '',
        website:
          socialLinks.website !== undefined
            ? sanitizeString(socialLinks.website, 300)
            : existingLinks.website || '',
        youtube:
          socialLinks.youtube !== undefined
            ? sanitizeString(socialLinks.youtube, 300)
            : existingLinks.youtube || '',
        instagram:
          socialLinks.instagram !== undefined
            ? sanitizeString(socialLinks.instagram, 300)
            : existingLinks.instagram || '',
        xUrl:
          socialLinks.xUrl !== undefined
            ? sanitizeString(socialLinks.xUrl, 300)
            : existingLinks.xUrl || '',
        github:
          socialLinks.github !== undefined
            ? sanitizeString(socialLinks.github, 300)
            : existingLinks.github || '',
        leetcode:
          socialLinks.leetcode !== undefined
            ? sanitizeString(socialLinks.leetcode, 300)
            : existingLinks.leetcode || '',
      };
    }

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      { $set: profileFields },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    ).populate('user', 'name email slug phoneNumber');

    // Automatically delete removed or replaced portfolio images from Cloudinary
    if (portfolio !== undefined && Array.isArray(existingProfile?.portfolio)) {
      try {
        const newPublicIds = new Set(
          (Array.isArray(profileFields.portfolio) ? profileFields.portfolio : [])
            .map((item) => extractCloudinaryPublicId(item?.imageUrl))
            .filter(Boolean)
        );

        const removedPublicIds = existingProfile.portfolio
          .map((item) => extractCloudinaryPublicId(item?.imageUrl))
          .filter((pubId) => pubId && !newPublicIds.has(pubId));

        if (removedPublicIds.length > 0) {
          await Promise.all(removedPublicIds.map((pubId) => destroyCloudinaryAsset(pubId)));
        }
      } catch (cleanupErr) {
        console.error('Portfolio Cloudinary cleanup warning:', cleanupErr.message);
      }
    }

    // Automatically clean up legacy profile photo if replaced by a different Cloudinary public_id
    if (existingProfile?.profileImage && safeProfileImage) {
      const oldAvatarPubId = extractCloudinaryPublicId(existingProfile.profileImage);
      const newAvatarPubId = extractCloudinaryPublicId(safeProfileImage);
      if (oldAvatarPubId && oldAvatarPubId !== newAvatarPubId) {
        await destroyCloudinaryAsset(oldAvatarPubId);
      }
    }

    try {
      await Idea.updateMany(
        { authorId: req.user.id },
        {
          $set: {
            authorName: profile.user.name,
            designation: profile.designation,
            company: profile.companyName,
            profileImage: profile.profileImage,
          },
        }
      );
    } catch (syncError) {
      console.error('Failed to sync past ideas:', syncError);
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error('Profile Upsert Error:', error);
    next(error);
  }
};

// @desc    Get profile by user ID (Public View — Private Fields Excluded)
// @route   GET /api/v1/profile/user/:userId
exports.getProfileByUserId = async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) {
      return res.status(400).json({ success: false, error: 'Invalid user ID' });
    }

    const profile = await Profile.findOne({ user: req.params.userId })
      .select(PUBLIC_PROFILE_EXCLUSIONS)
      .populate('user', 'name slug');

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found for this user' });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};

// @desc    Get profile by slug (Public View — Private Fields Excluded)
// @route   GET /api/v1/profile/slug/:slug
exports.getProfileBySlug = async (req, res) => {
  try {
    const slug = typeof req.params.slug === 'string' ? req.params.slug.trim().toLowerCase() : '';
    const user = await User.findOne({ slug }).select('name slug');
    if (!user) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }

    const profile = await Profile.findOne({ user: user._id })
      .select(PUBLIC_PROFILE_EXCLUSIONS)
      .populate('user', 'name slug');

    if (!profile) {
      return res.status(200).json({
        success: true,
        data: {
          user: { _id: user._id, name: user.name, slug: user.slug },
          designation: 'Member',
          bio: 'This user is still setting up their profile.',
          skills: [],
          languages: [],
          hourlyRate: 499,
          sessionPricing: DEFAULT_TIERS,
          profileImage: 'default-avatar.png',
        },
      });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error('Error fetching profile by slug:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// @desc    Get profile by either User ID or Profile ID (Public View)
// @route   GET /api/v1/profile/any/:id
exports.getProfileByAnyId = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, error: 'Invalid ID' });
    }

    let profile = await Profile.findOne({ user: id })
      .select(PUBLIC_PROFILE_EXCLUSIONS)
      .populate('user', 'name slug');
    if (!profile) {
      profile = await Profile.findById(id)
        .select(PUBLIC_PROFILE_EXCLUSIONS)
        .populate('user', 'name slug');
    }
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }
    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle or Heartbeat Live Status for Experts
// @route   PUT /api/v1/profile/live-status
exports.toggleLiveStatus = async (req, res) => {
  try {
    const existingProfile = await Profile.findOne({ user: req.user.id });
    if (!existingProfile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    if (existingProfile.role !== 'expert') {
      return res.status(403).json({
        success: false,
        error: 'Only mentors can go live.',
      });
    }

    const isLive = req.body.isLive !== undefined ? Boolean(req.body.isLive) : true;
    const newStatus = isLive ? 'available' : 'offline';

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      {
        $set: {
          isLive,
          liveConnectionStatus: newStatus,
          lastActiveAt: new Date(),
        },
      },
      { new: true }
    ).populate('user', 'name email slug');

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error('Live Toggle Error:', error);
    res.status(500).json({ success: false, message: 'Server error while toggling live status' });
  }
};

// @desc    Get all Student Profiles for the Home Screen Talent Section (ReDoS-Safe & Capped)
// @route   GET /api/v1/profile/talent
exports.getStudentTalent = async (req, res) => {
  try {
    const rawIntent = typeof req.query.intent === 'string' ? req.query.intent.trim() : '';
    const query = { role: 'student' };

    if (rawIntent && rawIntent !== 'All') {
      const safeIntent = escapeRegex(rawIntent.slice(0, 60));
      query.studentLookingFor = { $regex: safeIntent, $options: 'i' };
    }

    // 1. Fetch profiles matching role and intent
    const students = await Profile.find(query)
      .select(PUBLIC_PROFILE_EXCLUSIONS)
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    // 2. Fetch active users manually to avoid Mongoose populate match casting errors
    const userIds = students.map((s) => s.user).filter(Boolean);
    const activeUsers = await User.collection
      .find({
        _id: { $in: userIds },
        isDeleted: { $ne: true },
        accountStatus: { $nin: ['deleted', 'suspended'] },
      })
      .toArray();

    const activeUserMap = new Map(
      activeUsers.map((u) => [String(u._id), { _id: u._id, name: u.name, slug: u.slug }])
    );

    // 3. Attach user details and filter out inactive accounts
    const validStudents = students
      .map((s) => ({
        ...s,
        user: activeUserMap.get(String(s.user)) || null,
      }))
      .filter((s) => s.user != null);

    res.status(200).json({
      success: true,
      count: validStudents.length,
      data: validStudents,
    });
  } catch (error) {
    console.error('Error fetching talent:', error);
    res.status(500).json({ success: false, error: 'Server Error fetching talent' });
  }
};

// @desc    Auto-save just the profile picture (Cleans up legacy asset if public_id changed)
// @route   PATCH /api/v1/profile/image
exports.updateProfileImage = async (req, res) => {
  try {
    const { profileImage } = req.body;
    if (
      typeof profileImage !== 'string' ||
      !profileImage.trim().startsWith('https://')
    ) {
      return res.status(400).json({
        success: false,
        error: 'A valid HTTPS image URL is required.',
      });
    }

    const cleanImageUrl = profileImage.trim().slice(0, 500);
    const existingProfile = await Profile.findOne({ user: req.user.id }).select('profileImage');

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      {
        $set: { profileImage: cleanImageUrl },
        $setOnInsert: { role: 'student' },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    if (existingProfile?.profileImage) {
      const oldPubId = extractCloudinaryPublicId(existingProfile.profileImage);
      const newPubId = extractCloudinaryPublicId(cleanImageUrl);
      if (oldPubId && oldPubId !== newPubId) {
        await destroyCloudinaryAsset(oldPubId);
      }
    }

    try {
      await Idea.updateMany(
        { authorId: req.user.id },
        { $set: { profileImage: profile.profileImage } }
      );
    } catch (syncError) {
      console.error('Failed to sync past ideas:', syncError);
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error('Image Auto-Save Error:', error);
    res.status(500).json({ success: false, error: 'Failed to auto-save image' });
  }
};

// @desc    Generate a secure, 1-hour Cloudinary signed upload signature
// @route   GET /api/v1/profile/upload-signature?type=profile|portfolio&existingUrl=...
exports.getUploadSignature = async (req, res) => {
  try {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    if (!cloudName || !apiKey || !apiSecret) {
      return res.status(503).json({
        success: false,
        error: 'Image upload service is not configured on the server.',
      });
    }

    const uploadType = req.query.type === 'portfolio' ? 'portfolio' : 'profile';
    const timestamp = Math.round(Date.now() / 1000);

    let publicId;
    let overwrite;

    if (uploadType === 'portfolio') {
      const existingPubId = extractCloudinaryPublicId(req.query.existingUrl);
      const userPrefix = `yb_portfolio/project_${req.user.id}_`;

      // If editing an existing signed portfolio cover owned by this user, overwrite it in-place
      if (existingPubId && existingPubId.startsWith(userPrefix)) {
        publicId = existingPubId;
        overwrite = 'true';
      } else {
        publicId = `${userPrefix}${timestamp}_${Math.floor(Math.random() * 1000)}`;
        overwrite = 'false';
      }
    } else {
      publicId = `yb_profiles/profile_pic_${req.user.id}`;
      overwrite = 'true';
    }

    const paramsToSign = {
      overwrite,
      public_id: publicId,
      timestamp,
    };

    const signature = cloudinary.utils.api_sign_request(paramsToSign, apiSecret);

    return res.status(200).json({
      success: true,
      data: {
        cloudName,
        apiKey,
        signature,
        timestamp: String(timestamp),
        publicId,
        overwrite,
      },
    });
  } catch (error) {
    console.error('Cloudinary Sign Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Could not generate upload signature.',
    });
  }
};

// @desc    Submit Bug Report or Help & Support Inquiry from Mobile App
// @route   POST /api/v1/profile/support-ticket
exports.submitSupportTicket = async (req, res) => {
  try {
    const { type, category, message } = req.body;
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const currentUser = await User.findById(req.user.id).select('name email phoneNumber');
    const adminEmail =
      process.env.ADMIN_EMAIL || process.env.EMAIL_USER || 'yashwanthbondapalli@ybconnect.in';

    await sendEmail({
      email: adminEmail,
      subject: `🛠️ YB Connect ${type === 'problem_report' ? 'Bug Report' : 'Support'}: ${
        category || 'General'
      }`,
      message: `New Support Ticket from YB Connect App:\n\n- User ID: ${req.user.id}\n- User: ${
        currentUser?.name || 'User'
      } (${currentUser?.email || 'No email'})\n- Phone: ${
        currentUser?.phoneNumber || 'N/A'
      }\n- Category: ${category || 'General'}\n- Message:\n${message.trim().slice(0, 1500)}`,
    });

    return res.status(200).json({ success: true, message: 'Support ticket submitted' });
  } catch (err) {
    console.error('Support Ticket Warning:', err.message);
    return res.status(200).json({ success: true, message: 'Support ticket logged' });
  }
};

const getISTDateParts = (dateObj) => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(dateObj);
  const map = {};
  parts.forEach((p) => {
    map[p.type] = p.value;
  });
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    dateStr: `${map.year}-${map.month}-${map.day}`,
    dayOfWeek: weekdayMap[map.weekday],
  };
};

// @desc    Dynamic Multi-Duration & Range-Safe Slot Generator (IST)
// @route   GET /api/v1/profile/user/:id/slots?duration=30
exports.getExpertSlots = async (req, res) => {
  try {
    const { id: expertId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(expertId)) {
      return res.status(400).json({ success: false, error: 'Invalid expert ID' });
    }

    const requestedDuration = Number(req.query.duration) || 30;

    const profile = await Profile.findOne({ user: expertId });

    // Fallback: If mentor hasn't configured schedule rules yet, provide default 10 AM - 6 PM IST slots
    let days = profile?.scheduleRules?.days;
    if (!profile || !profile.scheduleRules || !Array.isArray(days) || days.length === 0) {
      days = [1, 2, 3, 4, 5].map((d) => ({
        dayOfWeek: d,
        timeWindows: [{ start: '10:00', end: '18:00' }],
      }));
    }

    const bufferDuration = Math.max(0, Number(profile?.scheduleRules?.bufferDuration) || 0);
    const dateOverrides = profile?.scheduleRules?.dateOverrides || [];
    const blackoutDates = (profile?.scheduleRules?.blackoutDates || []).map((d) =>
      getISTDateParts(new Date(d)).dateStr
    );

    const sessionDuration = [10, 20, 30, 40, 60].includes(requestedDuration)
      ? requestedDuration
      : Number(profile?.scheduleRules?.sessionDuration) || 30;

    const now = new Date();
    const minimumBookableMs = now.getTime() + 10 * 60 * 1000;
    const horizonMs = now.getTime() + 14 * 24 * 60 * 60 * 1000;

    // Use native collection find to prevent any Mongoose query cast errors
    const existingRequests = await CallRequest.collection
      .find({
        recipient: new mongoose.Types.ObjectId(expertId),
        status: 'accepted',
        scheduledAt: {
          $gte: new Date(now.getTime() - 2 * 60 * 60 * 1000),
          $lte: new Date(horizonMs),
        },
      })
      .toArray();

    const bookedIntervals = existingRequests.map((reqItem) => {
      const startMs = new Date(reqItem.scheduledAt).getTime();
      const durMins = Number(reqItem.durationMinutes) || 30;
      const endMs = reqItem.scheduledEndAt
        ? new Date(reqItem.scheduledEndAt).getTime()
        : startMs + durMins * 60 * 1000;
      return {
        startMs,
        endMs: endMs + bufferDuration * 60 * 1000,
      };
    });

    const availableSlots = [];
    const sessionMs = sessionDuration * 60 * 1000;
    const stepMinutes =
      bufferDuration > 0
        ? sessionDuration + bufferDuration
        : sessionDuration <= 20
        ? sessionDuration
        : 30;
    const stepMs = stepMinutes * 60 * 1000;

    for (let d = 0; d < 14; d++) {
      const targetInstant = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
      const { dateStr, dayOfWeek } = getISTDateParts(targetInstant);

      if (blackoutDates.includes(dateStr)) continue;

      const override = dateOverrides.find((o) => o.date === dateStr);
      if (override && override.isUnavailable) continue;

      let timeWindows = [];
      if (override && Array.isArray(override.timeWindows) && override.timeWindows.length > 0) {
        timeWindows = override.timeWindows;
      } else {
        const workingDay = days.find((day) => Number(day.dayOfWeek) === dayOfWeek);
        if (!workingDay || !Array.isArray(workingDay.timeWindows)) continue;
        timeWindows = workingDay.timeWindows;
      }

      timeWindows.forEach((window) => {
        if (!window.start || !window.end) return;
        const [startHour, startMin] = window.start.split(':').map(Number);
        const [endHour, endMin] = window.end.split(':').map(Number);

        // Construct IST date safely by parsing UTC offset parts
        const baseIsoString = `${dateStr}T00:00:00.000+05:30`;
        const baseEpochMs = new Date(baseIsoString).getTime();

        const windowStartMs = baseEpochMs + (startHour * 60 + startMin) * 60 * 1000;
        const windowEndMs = baseEpochMs + (endHour * 60 + endMin) * 60 * 1000;

        let candidateStartMs = windowStartMs;

        while (candidateStartMs + sessionMs <= windowEndMs) {
          const candidateEndMs = candidateStartMs + sessionMs;

          const isPastNoticePeriod = candidateStartMs >= minimumBookableMs;
          const hasOverlap = bookedIntervals.some(
            (interval) => candidateStartMs < interval.endMs && candidateEndMs > interval.startMs
          );

          if (isPastNoticePeriod && !hasOverlap) {
            availableSlots.push(new Date(candidateStartMs));
          }

          candidateStartMs += stepMs;
        }
      });
    }

    const uniqueSlotsMs = [...new Set(availableSlots.map((date) => date.getTime()))];
    const finalCleanSlots = uniqueSlotsMs.map((ms) => new Date(ms)).sort((a, b) => a - b);

    res.status(200).json({
      success: true,
      durationMinutes: sessionDuration,
      timezone: 'Asia/Kolkata',
      data: finalCleanSlots,
    });
  } catch (error) {
    console.error('Slot Generation Error:', error);
    res.status(500).json({ success: false, error: 'Failed to calculate available slots.' });
  }
};