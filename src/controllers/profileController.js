// backend/src/controllers/profileController.js
const Profile = require('../models/Profile');
const User = require('../models/User');
const CallRequest = require('../models/CallRequest');
const generateUniqueSlug = require('../utils/generateSlug');
const Idea = require('../models/Idea');

// Mandatory minimum price floors per duration (in INR)
const PRICING_FLOORS = {
  10: 199,
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

/**
 * Validates and normalizes the 5-tier sessionPricing array.
 * Ensures no tier is below its minimum floor and at least one tier is enabled.
 */
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

// @desc    Get current user's profile
exports.getCurrentUserProfile = async (req, res, next) => {
  try {
    const profile = await Profile.findOne({ user: req.user.id }).populate('user', [
      'name',
      'email',
      'slug',
      'phoneNumber',
    ]);

    if (!profile) {
      return res.status(404).json({
        success: false,
        error: 'There is no profile for this user',
      });
    }

    res.status(200).json({
      success: true,
      data: profile,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create or Update Profile
exports.upsertProfile = async (req, res, next) => {
  try {
    const {
      role,
      yearOfStudy,
      university,
      major,
      minor,
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

    // 1. Update Name AND dynamically regenerate Slug if changed
    if (name && name.trim() !== '') {
      const cleanName = name.trim();
      const currentUser = await User.findById(req.user.id);

      if (currentUser && (currentUser.name !== cleanName || !currentUser.slug)) {
        const newSlug = await generateUniqueSlug(cleanName);
        await User.findByIdAndUpdate(req.user.id, {
          name: cleanName,
          slug: newSlug,
        });
      }
    }

    // 2. Validate 5-Tier Session Pricing (for Experts)
    const effectiveRole = role || 'expert';
    let validatedPricing = DEFAULT_TIERS;
    let derivedBaseRate = Number(hourlyRate) || 499;

    if (effectiveRole === 'expert') {
      const parsedPricing =
        typeof sessionPricing === 'string' ? JSON.parse(sessionPricing) : sessionPricing;
      validatedPricing = normalizeSessionPricing(parsedPricing, hourlyRate);

      // Keep hourlyRate synced to the 30-min tier (or lowest enabled tier) for feed cards
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

    // 3. Build profileFields object
    const profileFields = {
      user: req.user.id,
      role: effectiveRole,
      designation,
      companyName,
      shortDescription,
      whyBookMe,
      category,
      city,
      bio,
      yearsOfExperience: Number(yearsOfExperience) || 0,
      achievements,
      hourlyRate: derivedBaseRate,
      sessionPricing: validatedPricing,
      profileImage: profileImage || 'default-avatar.png',
      'zoomCredentials.isConnected': true, // Native LiveKit is always connected
      yearOfStudy,
      university,
      major,
      minor,
      studentLookingFor,
      techInterests,
      studentProjects,
      internships,
      certifications,
      leadership,
    };

    if (phoneNumber && phoneNumber.trim() !== '') {
      profileFields.phoneNumber = phoneNumber;
    }
    if (availability) {
      profileFields.availability = availability;
    }

    // 4. Normalize Schedule Rules (Uniform or Custom Per-Day)
    if (scheduleRules) {
      const parsedRules =
        typeof scheduleRules === 'string' ? JSON.parse(scheduleRules) : scheduleRules;

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

    // 5. Handle String Arrays
    if (skills) {
      profileFields.skills = Array.isArray(skills)
        ? skills
        : skills.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (techSkills) {
      profileFields.techSkills = Array.isArray(techSkills)
        ? techSkills
        : techSkills.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (softSkills) {
      profileFields.softSkills = Array.isArray(softSkills)
        ? softSkills
        : softSkills.split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (languages) {
      profileFields.languages = Array.isArray(languages)
        ? languages
        : languages.split(',').map((l) => l.trim()).filter(Boolean);
    }
    if (industries) {
      profileFields.industries = Array.isArray(industries)
        ? industries
        : industries.split(',').map((i) => i.trim()).filter(Boolean);
    }
    if (interests) {
      profileFields.interests = Array.isArray(interests)
        ? interests
        : interests.split(',').map((i) => i.trim()).filter(Boolean);
    }

    // 6. Handle Structured Arrays
    if (experience) {
      profileFields.experience =
        typeof experience === 'string' ? JSON.parse(experience) : experience;
    }
    if (servicesOffered) {
      profileFields.servicesOffered =
        typeof servicesOffered === 'string' ? JSON.parse(servicesOffered) : servicesOffered;
    }
    if (portfolio) {
      profileFields.portfolio =
        typeof portfolio === 'string' ? JSON.parse(portfolio) : portfolio;
    }

    // 7. Handle Social Links
    if (socialLinks) {
      profileFields.socialLinks = {
        linkedin: socialLinks.linkedin || '',
        instagram: socialLinks.instagram || '',
        xUrl: socialLinks.xUrl || '',
        website: socialLinks.website || '',
        github: socialLinks.github || '',
        leetcode: socialLinks.leetcode || '',
      };
    }

    // 8. Save to MongoDB
    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      { $set: profileFields },
      { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
    ).populate('user', 'name email slug phoneNumber');

    // Synchronize past Idea Hub posts with updated author info
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

// @desc    Get profile by user ID (Public View)
exports.getProfileByUserId = async (req, res, next) => {
  try {
    const profile = await Profile.findOne({ user: req.params.userId }).populate(
      'user',
      'name slug'
    );

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found for this user' });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};

// @desc    Get profile by slug
exports.getProfileBySlug = async (req, res) => {
  try {
    const { slug } = req.params;
    const user = await User.findOne({ slug }).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'Expert not found' });
    }

    const profile = await Profile.findOne({ user: user._id }).populate('user', 'name slug');

    if (!profile) {
      return res.status(200).json({
        success: true,
        data: {
          user: { _id: user._id, name: user.name, slug: user.slug },
          designation: 'New Expert',
          bio: 'This expert is still setting up their profile.',
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

// @desc    Get profile by either User ID or Profile ID
exports.getProfileByAnyId = async (req, res, next) => {
  try {
    const { id } = req.params;
    let profile = await Profile.findOne({ user: id }).populate('user', 'name slug');
    if (!profile) {
      profile = await Profile.findById(id).populate('user', 'name slug');
    }
    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }
    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};

// @desc    Toggle Live Status (Instant Solver)
exports.toggleLiveStatus = async (req, res, next) => {
  try {
    const { isLive, status } = req.body;
    const newStatus = status || (isLive ? 'available' : 'offline');

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      {
        $set: {
          isLive,
          liveConnectionStatus: newStatus,
          lastActiveAt: Date.now(),
        },
      },
      { new: true }
    ).populate('user', 'name email slug');

    if (!profile) {
      return res.status(404).json({ success: false, error: 'Profile not found' });
    }

    res.status(200).json({ success: true, data: profile });
  } catch (error) {
    console.error('Live Toggle Error:', error);
    res.status(500).json({ success: false, message: 'Server error while toggling live status' });
  }
};

// @desc    Get all Student Profiles for the Home Screen Talent Section
exports.getStudentTalent = async (req, res) => {
  try {
    const { intent } = req.query;
    const query = { role: 'student' };

    if (intent && intent !== 'All') {
      query.studentLookingFor = { $regex: intent, $options: 'i' };
    }

    const students = await Profile.find(query)
      .populate('user', 'name slug')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: students.length,
      data: students,
    });
  } catch (error) {
    console.error('Error fetching talent:', error);
    res.status(500).json({ success: false, error: 'Server Error fetching talent' });
  }
};

// @desc    Auto-save just the profile picture
exports.updateProfileImage = async (req, res) => {
  try {
    const { profileImage, role } = req.body;
    if (!profileImage) {
      return res.status(400).json({ success: false, error: 'No image URL provided' });
    }

    const profile = await Profile.findOneAndUpdate(
      { user: req.user.id },
      {
        $set: { profileImage },
        $setOnInsert: { role: role || 'expert' },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

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

/**
 * Helper: Returns { year, month, day, dayOfWeek } for a given UTC timestamp in Asia/Kolkata
 */
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

// =========================================================================
// 🚀 DYNAMIC MULTI-DURATION & RANGE-SAFE SLOT GENERATOR (IST)
// @route GET /api/v1/profile/user/:id/slots?duration=30
// =========================================================================
exports.getExpertSlots = async (req, res) => {
  try {
    const { id: expertId } = req.params;
    const requestedDuration = Number(req.query.duration) || 30;

    const profile = await Profile.findOne({ user: expertId });
    if (!profile || !profile.scheduleRules || !Array.isArray(profile.scheduleRules.days)) {
      return res.status(200).json({ success: true, data: [] });
    }

    const bufferDuration = Math.max(0, Number(profile.scheduleRules.bufferDuration) || 0);
    const days = profile.scheduleRules.days;
    const dateOverrides = profile.scheduleRules.dateOverrides || [];
    const blackoutDates = (profile.scheduleRules.blackoutDates || []).map((d) =>
      getISTDateParts(new Date(d)).dateStr
    );

    const sessionDuration = [10, 20, 30, 40, 60].includes(requestedDuration)
      ? requestedDuration
      : Number(profile.scheduleRules.sessionDuration) || 30;

    const now = new Date();
    const minimumBookableMs = now.getTime() + 10 * 60 * 1000; // 10-minute minimum notice
    const horizonMs = now.getTime() + 14 * 24 * 60 * 60 * 1000;

    // Fetch all active bookings in the next 14 days to prevent range overlaps
    const existingRequests = await CallRequest.find({
      recipient: expertId,
      status: { $in: ['holding', 'accepted'] },
      scheduledAt: {
        $gte: new Date(now.getTime() - 2 * 60 * 60 * 1000),
        $lte: new Date(horizonMs),
      },
    })
      .select('scheduledAt scheduledEndAt durationMinutes')
      .lean();

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
    // Step interval: For 10/20m sessions, step by (sessionDuration + buffer). For 30/40/60m, step by 30m (or sessionDuration + buffer if buffer > 0)
    const stepMinutes =
      bufferDuration > 0 ? sessionDuration + bufferDuration : sessionDuration <= 20 ? sessionDuration : 30;
    const stepMs = stepMinutes * 60 * 1000;

    for (let d = 0; d < 14; d++) {
      const targetInstant = new Date(now.getTime() + d * 24 * 60 * 60 * 1000);
      const { dateStr, dayOfWeek } = getISTDateParts(targetInstant);

      // Skip blackout / holiday dates
      if (blackoutDates.includes(dateStr)) continue;

      // Check date-specific override first, then recurring weekly day
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

        let slotStartTime = new Date(
          `${dateStr}T${String(startHour).padStart(2, '0')}:${String(startMin).padStart(
            2,
            '0'
          )}:00+05:30`
        );
        const windowEndTime = new Date(
          `${dateStr}T${String(endHour).padStart(2, '0')}:${String(endMin).padStart(
            2,
            '0'
          )}:00+05:30`
        );

        while (slotStartTime.getTime() + sessionMs <= windowEndTime.getTime()) {
          const candidateStartMs = slotStartTime.getTime();
          const candidateEndMs = candidateStartMs + sessionMs;

          const isPastNoticePeriod = candidateStartMs >= minimumBookableMs;
          const hasOverlap = bookedIntervals.some(
            (interval) => candidateStartMs < interval.endMs && candidateEndMs > interval.startMs
          );

          if (isPastNoticePeriod && !hasOverlap) {
            availableSlots.push(new Date(candidateStartMs));
          }

          slotStartTime = new Date(candidateStartMs + stepMs);
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