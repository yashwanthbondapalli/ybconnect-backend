// backend/src/controllers/requestController.js
const CallRequest = require('../models/CallRequest');
const Profile = require('../models/Profile');
const sendEmail = require('../utils/emailHelper');
const sendPushNotification = require('../utils/pushHelper');
const { ensureBookingVideoSession } = require('../utils/livekitHelper');

const DEFAULT_FLOOR_BY_DURATION = {
  10: 10,
  20: 299,
  30: 499,
  40: 599,
  60: 999,
};

/**
 * Checks whether `[startMs, endMs]` overlaps any active `holding` or `accepted` booking for the expert
 */
const findOverlappingBooking = async (expertId, startMs, endMs, excludeRequestId = null) => {
  const windowLookback = new Date(startMs - 2 * 60 * 60 * 1000);
  const windowLookahead = new Date(endMs + 2 * 60 * 60 * 1000);

  const query = {
    recipient: expertId,
    status: { $in: ['holding', 'accepted'] },
    scheduledAt: { $gte: windowLookback, $lte: windowLookahead },
  };
  if (excludeRequestId) {
    query._id = { $ne: excludeRequestId };
  }

  const candidates = await CallRequest.find(query)
    .select('scheduledAt scheduledEndAt durationMinutes')
    .lean();

  return candidates.find((item) => {
    const existingStartMs = new Date(item.scheduledAt).getTime();
    const durMins = Number(item.durationMinutes) || 30;
    const existingEndMs = item.scheduledEndAt
      ? new Date(item.scheduledEndAt).getTime()
      : existingStartMs + durMins * 60 * 1000;
    return startMs < existingEndMs && endMs > existingStartMs;
  });
};

// ==========================================
// CASE 1: USER A SENDS CUSTOM REQUEST TO EXPERT B
// ==========================================
exports.createCallRequest = async (req, res, next) => {
  try {
    const { recipientId, topic, message, budgetMin, budgetMax, durationMinutes } = req.body;

    if (req.user.id === recipientId) {
      return res.status(400).json({ success: false, error: 'Cannot request yourself.' });
    }

    const validDuration = [10, 20, 30, 40, 60].includes(Number(durationMinutes))
      ? Number(durationMinutes)
      : 30;

    const callRequest = await CallRequest.create({
      requester: req.user.id,
      recipient: recipientId,
      topic,
      message,
      durationMinutes: validDuration,
      status: 'pending',
      budget: { min: budgetMin, max: budgetMax },
    });

    await sendPushNotification(
      recipientId,
      'New Mentorship Request! 🚀',
      `Someone wants to book a ${validDuration}-min session with you for "${topic}". Check your bookings!`
    );

    res.status(201).json({ success: true, data: callRequest });
  } catch (error) {
    next(error);
  }
};

// ==========================================
// FETCH ALL BOOKINGS FOR LOGGED-IN USER
// ==========================================
exports.getRequests = async (req, res, next) => {
  try {
    let requests = await CallRequest.find({
      $or: [{ requester: req.user.id }, { recipient: req.user.id }],
    })
      .populate('requester', 'name email slug profileImage')
      .populate('recipient', 'name email slug profileImage')
      .sort({ createdAt: -1 })
      .lean();

    requests = requests.map((reqData) => {
      // Normalize legacy review location if stored inside zoomMeeting
      if (reqData.zoomMeeting && reqData.zoomMeeting.review && !reqData.review) {
        reqData.review = reqData.zoomMeeting.review;
      }

      // Gatekeeper: Hide room links from unpaid students
      const isRequester = reqData.requester?._id?.toString() === req.user.id;
      const isPaid = ['paid', 'payout_ready', 'payout_processing'].includes(reqData.paymentStatus);

      if (isRequester && !isPaid) {
        if (reqData.zoomMeeting) {
          reqData.zoomMeeting.joinUrl = 'hidden_until_paid';
          reqData.zoomMeeting.startUrl = 'hidden';
        }
        if (reqData.videoSession) {
          reqData.videoSession.roomName = 'hidden_until_paid';
        }
      }
      return reqData;
    });

    res.status(200).json({ success: true, data: requests });
  } catch (error) {
    next(error);
  }
};

// ==========================================
// UPDATE STATUS (OFFER / ACCEPT / CANCEL)
// ==========================================
exports.updateRequestStatus = async (req, res, next) => {
  try {
    const { status, scheduledAt, amount, proposedSlots, durationMinutes } = req.body;
    let callRequest = await CallRequest.findById(req.params.id);

    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    const isRecipient = callRequest.recipient.toString() === req.user.id;
    const isRequester = callRequest.requester.toString() === req.user.id;

    if (!isRecipient && !isRequester) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (['completed', 'rejected', 'cancelled'].includes(callRequest.status)) {
      return res.status(400).json({
        success: false,
        error: `This request is already ${callRequest.status}.`,
      });
    }

    // EXPERT MAKES AN OFFER
    if (isRecipient && status === 'offer_made') {
      if (!amount || !proposedSlots || proposedSlots.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'You must provide a price and at least one proposed time slot to make an offer.',
        });
      }

      if (!Array.isArray(proposedSlots) || proposedSlots.length === 0 || proposedSlots.length > 3) {
        return res.status(400).json({
          success: false,
          error: 'Please provide between 1 and 3 proposed time slots.',
        });
      }

      const validDuration = [10, 20, 30, 40, 60].includes(Number(durationMinutes))
        ? Number(durationMinutes)
        : Number(callRequest.durationMinutes) || 30;

      const minFloor = DEFAULT_FLOOR_BY_DURATION[validDuration] || 10;
      if (Number(amount) < minFloor) {
        return res.status(400).json({
          success: false,
          error: `Minimum allowed fee for a ${validDuration}-minute session is ₹${minFloor}.`,
        });
      }

      const now = Date.now();
      const parsedSlots = proposedSlots.map((slot) => new Date(slot));

      if (parsedSlots.some((date) => Number.isNaN(date.getTime()))) {
        return res.status(400).json({
          success: false,
          error: 'One or more proposed time slots are invalid.',
        });
      }

      if (parsedSlots.some((date) => date.getTime() <= now)) {
        return res.status(400).json({
          success: false,
          error: 'Proposed time slots must be in the future.',
        });
      }

      const uniqueSlotTimes = new Set(parsedSlots.map((date) => date.getTime()));
      if (uniqueSlotTimes.size !== parsedSlots.length) {
        return res.status(400).json({
          success: false,
          error: 'Proposed time slots cannot contain duplicates.',
        });
      }

      callRequest.amount = Math.round(Number(amount));
      callRequest.durationMinutes = validDuration;
      callRequest.proposedSlots = proposedSlots;
      callRequest.status = 'offer_made';
    } else if (isRecipient && status === 'rejected') {
      callRequest.status = 'rejected';
    }

    // STUDENT ACCEPTS OFFER OR CANCELS
    if (isRequester) {
      if (status === 'accepted') {
        if (callRequest.status !== 'offer_made') {
          return res.status(400).json({
            success: false,
            error: 'You cannot accept a session that has not been offered yet.',
          });
        }
        if (!scheduledAt) {
          return res.status(400).json({
            success: false,
            error: 'You must select one of the proposed time slots to confirm the session.',
          });
        }

        const selectedTimeMs = new Date(scheduledAt).getTime();
        const isValidProposedSlot = callRequest.proposedSlots.some(
          (slot) => new Date(slot).getTime() === selectedTimeMs
        );

        if (!isValidProposedSlot) {
          return res.status(400).json({
            success: false,
            error: 'Invalid time slot. Please select one of the time slots proposed by the expert.',
          });
        }

        const tenMinsFromNowMs = Date.now() + 10 * 60 * 1000;
        if (selectedTimeMs < tenMinsFromNowMs) {
          return res.status(400).json({
            success: false,
            error: 'The selected time slot is too soon. Please select a time at least 10 minutes from now.',
          });
        }

        const durMins = Number(callRequest.durationMinutes) || 30;
        const endTimeMs = selectedTimeMs + durMins * 60 * 1000;

        const conflict = await findOverlappingBooking(
          callRequest.recipient,
          selectedTimeMs,
          endTimeMs,
          callRequest._id
        );
        if (conflict) {
          return res.status(409).json({
            success: false,
            error: 'This time slot now overlaps with another confirmed booking. Please request a new time.',
          });
        }

        callRequest.scheduledAt = new Date(selectedTimeMs);
        callRequest.scheduledEndAt = new Date(endTimeMs);
        callRequest.status = 'accepted';
        ensureBookingVideoSession(callRequest);
      } else if (status === 'cancelled') {
        if (callRequest.paymentStatus === 'paid') {
          return res.status(400).json({
            success: false,
            error: 'Cannot cancel a session that is already paid.',
          });
        }
        callRequest.status = 'cancelled';
      } else {
        return res.status(403).json({
          success: false,
          error: 'Students can only accept offers or cancel requests.',
        });
      }
    }

    await callRequest.save();

    callRequest = await CallRequest.findById(req.params.id)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    if (callRequest.status === 'offer_made') {
      try {
        const student = callRequest.requester;
        const expert = callRequest.recipient;

        await sendEmail({
          email: student.email,
          subject: `🔔 Action Required: ${expert.name} sent you an offer!`,
          message: `Hi ${student.name.split(' ')[0]},\n\nGood news! ${expert.name} has reviewed your mentorship request and made you an offer for ₹${callRequest.amount} (${callRequest.durationMinutes || 30} mins).\n\nThey have proposed available time slots for the session. Please open the YB Connect app, go to your Bookings tab, and tap "Review & Book" to pick your preferred time and complete payment.\n\nThank you,\nYour YB Connect Team`,
        });

        await sendPushNotification(
          student._id,
          'Offer Received! 🔔',
          `${expert.name} sent you an offer of ₹${callRequest.amount} (${callRequest.durationMinutes || 30}m). Tap to review and pick a slot!`
        );
      } catch (err) {
        console.error('⚠️ Failed to send offer notifications:', err.message);
      }
    }

    res.status(200).json({ success: true, data: callRequest });
  } catch (error) {
    next(error);
  }
};

// ==========================================
// 🚀 INSTANT BOOKING 10-MINUTE CART LOCK
// ==========================================
exports.createInstantHold = async (req, res, next) => {
  try {
    const { recipientId, topic, message, scheduledAt, durationMinutes } = req.body;

    if (req.user.id === recipientId) {
      return res.status(400).json({ success: false, error: 'Cannot book yourself.' });
    }

    const expertProfile = await Profile.findOne({ user: recipientId });
    if (!expertProfile) {
      return res.status(404).json({ success: false, error: 'Expert not found.' });
    }

    const requestedDuration = [10, 20, 30, 40, 60].includes(Number(durationMinutes))
      ? Number(durationMinutes)
      : Number(expertProfile.scheduleRules?.sessionDuration) || 30;

    // Look up the authoritative price from the expert's 5-tier sessionPricing
    const minFloor = DEFAULT_FLOOR_BY_DURATION[requestedDuration] || 499;
    let amount = minFloor;

    if (Array.isArray(expertProfile.sessionPricing) && expertProfile.sessionPricing.length > 0) {
      const tier = expertProfile.sessionPricing.find(
        (t) => Number(t.duration) === requestedDuration
      );
      if (tier) {
        if (tier.isEnabled === false) {
          return res.status(400).json({
            success: false,
            error: `The expert does not currently offer ${requestedDuration}-minute sessions.`,
          });
        }
        amount = Math.max(minFloor, Number(tier.price) || minFloor);
      }
    } else if (requestedDuration === 30 && Number(expertProfile.hourlyRate) >= minFloor) {
      amount = Number(expertProfile.hourlyRate);
    }

    const slotStartMs = new Date(scheduledAt).getTime();
    if (Number.isNaN(slotStartMs)) {
      return res.status(400).json({ success: false, error: 'Invalid slot timestamp.' });
    }

    if (slotStartMs < Date.now() + 5 * 60 * 1000) {
      return res.status(400).json({
        success: false,
        error: 'Please select a slot at least 10 minutes in the future.',
      });
    }

    const slotEndMs = slotStartMs + requestedDuration * 60 * 1000;

    // Range-based double-booking check
    const overlappingRequest = await findOverlappingBooking(recipientId, slotStartMs, slotEndMs);
    if (overlappingRequest) {
      return res.status(409).json({
        success: false,
        error: 'Someone else just reserved this time window! Please pick another slot.',
      });
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    const callRequest = new CallRequest({
      requester: req.user.id,
      recipient: recipientId,
      topic: topic.trim(),
      message: message ? message.trim() : '',
      amount,
      durationMinutes: requestedDuration,
      scheduledAt: new Date(slotStartMs),
      scheduledEndAt: new Date(slotEndMs),
      status: 'holding',
      expiresAt,
    });

    ensureBookingVideoSession(callRequest);
    await callRequest.save();

    res.status(201).json({ success: true, data: callRequest });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Someone else just reserved this exact slot! Please pick another time.',
      });
    }
    next(error);
  }
};

// @desc    Submit a rating and review for a completed session
// @route   POST /api/v1/requests/:id/review
exports.submitReview = async (req, res, next) => {
  try {
    const { rating, feedback } = req.body;
    const request = await CallRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    if (request.requester.toString() !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Only the student can leave a review.' });
    }

    if (request.status !== 'completed') {
      return res.status(400).json({
        success: false,
        error: 'You can only review completed sessions.',
      });
    }

    // Prevent reviewing sessions where the student never showed up
    if (
      request.videoSession?.status === 'student_no_show' ||
      request.zoomMeeting?.status === 'student_no_show'
    ) {
      return res.status(400).json({
        success: false,
        error: 'Reviews cannot be submitted for unattended sessions.',
      });
    }

    const reviewObj = {
      rating: Math.min(5, Math.max(1, Number(rating) || 5)),
      feedback: feedback || '',
      submittedAt: new Date(),
    };

    const updatedRequest = await CallRequest.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          review: reviewObj,
          'zoomMeeting.review': reviewObj,
        },
      },
      { new: true }
    );

    res.status(200).json({ success: true, data: updatedRequest });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all reviews for a specific expert
// @route   GET /api/v1/requests/expert/:expertId/reviews
exports.getExpertReviews = async (req, res, next) => {
  try {
    const { expertId } = req.params;

    let reviews = await CallRequest.find({
      recipient: expertId,
      status: 'completed',
      $or: [
        { 'review.rating': { $exists: true } },
        { 'zoomMeeting.review.rating': { $exists: true } },
      ],
    })
      .populate('requester', 'name email slug profileImage')
      .sort({ 'review.submittedAt': -1, 'zoomMeeting.review.submittedAt': -1 })
      .lean();

    reviews = reviews.map((reqItem) => {
      if (reqItem.zoomMeeting && reqItem.zoomMeeting.review && !reqItem.review) {
        reqItem.review = reqItem.zoomMeeting.review;
      }
      return reqItem;
    });

    let totalRating = 0;
    let averageRating = 0;

    if (reviews.length > 0) {
      totalRating = reviews.reduce((sum, reqItem) => sum + (reqItem.review?.rating || 0), 0);
      averageRating = (totalRating / reviews.length).toFixed(1);
    }

    res.status(200).json({
      success: true,
      count: reviews.length,
      stats: {
        averageRating: Number(averageRating),
        totalReviews: reviews.length,
      },
      data: reviews,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a submitted review (Student only)
// @route   DELETE /api/v1/requests/:id/review
exports.deleteReview = async (req, res, next) => {
  try {
    const request = await CallRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    if (request.requester.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'You can only delete your own reviews.',
      });
    }

    const updatedRequest = await CallRequest.findByIdAndUpdate(
      req.params.id,
      {
        $unset: {
          review: 1,
          'zoomMeeting.review': 1,
        },
      },
      { new: true }
    );

    res.status(200).json({ success: true, data: updatedRequest });
  } catch (error) {
    next(error);
  }
};

// ==========================================
// 🚀 SEND MEETING REMINDER NUDGE (MAX 5)
// ==========================================
exports.sendNudge = async (req, res, next) => {
  try {
    const { customMessage } = req.body;
    const request = await CallRequest.findById(req.params.id)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    if (!request) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    if (request.nudgesSent >= 5) {
      return res.status(400).json({ success: false, error: 'Maximum reminders sent.' });
    }

    const isRequester = request.requester._id.toString() === req.user.id;
    const sender = isRequester ? request.requester : request.recipient;
    const receiver = isRequester ? request.recipient : request.requester;

    const senderFirstName = sender.name.split(' ')[0];
    const defaultMsg = `${senderFirstName} is waiting for you in the YB Connect video call room. Please join now!`;
    const finalNotificationMsg =
      customMessage && customMessage.trim() !== ''
        ? `${senderFirstName} says: "${customMessage.trim()}"`
        : defaultMsg;

    request.nudgesSent = (request.nudgesSent || 0) + 1;
    await request.save();

    try {
      await sendPushNotification(receiver._id, 'Video Call Reminder! ⏰', finalNotificationMsg);
    } catch (pushErr) {}

    try {
      await sendEmail({
        email: receiver.email,
        subject: `🔔 Urgent: ${senderFirstName} is waiting in your YB Connect call!`,
        message: `Hi ${receiver.name.split(' ')[0]},\n\n${finalNotificationMsg}\n\nOpen the YB Connect app and go to your Bookings tab to join the video call.\n\nThank you,\nYour YB Connect Team`,
      });
    } catch (emailErr) {}

    res.status(200).json({ success: true, nudgesSent: request.nudgesSent });
  } catch (error) {
    next(error);
  }
};