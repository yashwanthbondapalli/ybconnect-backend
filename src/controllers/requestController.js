// backend/src/controllers/requestController.js
const CallRequest = require('../models/CallRequest');
const Profile = require('../models/Profile');
const sendEmail = require('../utils/emailHelper');
const sendPushNotification = require('../utils/pushHelper');
const { ensureBookingVideoSession } = require('../utils/livekitHelper');
const mongoose = require('mongoose');
const DEFAULT_FLOOR_BY_DURATION = {
  10: 10, // Kept at 10 so your ₹10 test sessions work seamlessly
  20: 299,
  30: 499,
  40: 599,
  60: 999,
};

const formatIST = (dateInput) => {
  if (!dateInput) return 'TBD';
  return new Date(dateInput).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
};

/**
 * Checks whether `[startMs, endMs]` overlaps any already-accepted booking for the expert
 */
const findOverlappingBooking = async (expertId, startMs, endMs, excludeRequestId = null) => {
  const windowLookback = new Date(startMs - 2 * 60 * 60 * 1000);
  const windowLookahead = new Date(endMs + 2 * 60 * 60 * 1000);

  const query = {
    recipient: new mongoose.Types.ObjectId(expertId),
    status: 'accepted',
    scheduledAt: { $gte: windowLookback, $lte: windowLookahead },
  };
  if (excludeRequestId) {
    query._id = { $ne: new mongoose.Types.ObjectId(excludeRequestId) };
  }

  const candidates = await CallRequest.collection.find(query).toArray();
  const nowMs = Date.now();

  return candidates.find((item) => {
    const existingStartMs = new Date(item.scheduledAt).getTime();
    if (existingStartMs < nowMs && item.paymentStatus !== 'paid') {
      return false;
    }
    const durMins = Number(item.durationMinutes) || 30;
    const existingEndMs = item.scheduledEndAt
      ? new Date(item.scheduledEndAt).getTime()
      : existingStartMs + durMins * 60 * 1000;
    return startMs < existingEndMs && endMs > existingStartMs;
  });
};

// ==========================================
// CASE 1: CUSTOM OPEN REQUEST
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
      `Someone wants to book a ${validDuration}-min session with you for "${topic}". Tap Bookings to review!`
    );

    res.status(201).json({ success: true, data: callRequest });
  } catch (error) {
    next(error);
  }
};

// ==========================================
// 🚀 CASE 2: STUDENT REQUESTS A SPECIFIC SLOT & PACKAGE (APPROVAL-FIRST)
// @route POST /api/v1/requests/instant-hold
// ==========================================
exports.createInstantHold = async (req, res, next) => {
  try {
    const { recipientId, topic, message, scheduledAt, durationMinutes } = req.body;

    if (req.user.id === recipientId) {
      return res.status(400).json({ success: false, error: 'Cannot book yourself.' });
    }

    const expertProfile = await Profile.findOne({ user: recipientId });
    if (!expertProfile) {
      return res.status(404).json({ success: false, error: 'Mentor profile not found.' });
    }

    const requestedDuration = [10, 20, 30, 40, 60].includes(Number(durationMinutes))
      ? Number(durationMinutes)
      : Number(expertProfile.scheduleRules?.sessionDuration) || 30;

    const minFloor = DEFAULT_FLOOR_BY_DURATION[requestedDuration] || 199;
    let amount = minFloor;

    if (Array.isArray(expertProfile.sessionPricing) && expertProfile.sessionPricing.length > 0) {
      const tier = expertProfile.sessionPricing.find(
        (t) => Number(t.duration) === requestedDuration
      );
      if (tier) {
        if (tier.isEnabled === false) {
          return res.status(400).json({
            success: false,
            error: `This mentor does not currently offer ${requestedDuration}-minute sessions.`,
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
        error: 'Please select a time slot at least 10 minutes in the future.',
      });
    }

    const slotEndMs = slotStartMs + requestedDuration * 60 * 1000;

    // Check if the mentor already approved another session in this time window
    const overlappingRequest = await findOverlappingBooking(recipientId, slotStartMs, slotEndMs);
    if (overlappingRequest) {
      return res.status(409).json({
        success: false,
        error: 'This time slot is already booked! Please pick another time.',
      });
    }

    // Create the booking in 'pending' status (Wait for Mentor Approval before payment!)
    const callRequest = new CallRequest({
      requester: req.user.id,
      recipient: recipientId,
      topic: topic.trim(),
      message: message ? message.trim() : '',
      amount,
      durationMinutes: requestedDuration,
      scheduledAt: new Date(slotStartMs),
      scheduledEndAt: new Date(slotEndMs),
      status: 'pending',
      paymentStatus: 'pending',
      expiresAt: undefined,
    });

    ensureBookingVideoSession(callRequest);
    await callRequest.save();

    const populated = await CallRequest.findById(callRequest._id)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    // Notify the Mentor immediately via Push + Email
    try {
      const istString = formatIST(slotStartMs);
      await Promise.all([
        sendPushNotification(
          recipientId,
          '📩 New Session Request!',
          `${populated.requester.name} requested a ${requestedDuration}m call (₹${amount}) on ${istString}. Tap to Accept or Decline!`
        ),
        sendEmail({
          email: populated.recipient.email,
          subject: `📩 New Booking Request from ${populated.requester.name}`,
          message: `Hi ${populated.recipient.name},\n\n${populated.requester.name} has requested a 1:1 mentorship session with you!\n\nDetails:\n- Topic: ${populated.topic}\n- Message: ${populated.message || 'N/A'}\n- Package: ${requestedDuration} Minutes (₹${amount})\n- Requested Time: ${istString} (IST)\n\nPlease open the YB Connect app -> Go to the "Bookings" tab -> Tap "Accept Request" or "Decline". Once you accept, the student will complete payment to lock the call.\n\nThank you,\nYour YB Connect Team`,
        }),
      ]);
    } catch (notifyErr) {
      console.error('Failed to send new request notification:', notifyErr.message);
    }

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
     // Inside exports.getRequests:
.populate('requester', 'name slug profileImage')
.populate('recipient', 'name slug profileImage')


      .sort({ createdAt: -1 })
      .lean();

    requests = requests.map((reqData) => {
      if (reqData.zoomMeeting && reqData.zoomMeeting.review && !reqData.review) {
        reqData.review = reqData.zoomMeeting.review;
      }

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

// =========================================================================
// 🚀 UPDATE STATUS (MENTOR ACCEPT / REJECT / 1-HR EMERGENCY CANCEL / STUDENT CANCEL)
// @route PUT /api/v1/requests/:id/status
// =========================================================================
exports.updateRequestStatus = async (req, res, next) => {
  try {
    const {
      status,
      scheduledAt,
      amount,
      proposedSlots,
      durationMinutes,
      cancelReason,
    } = req.body;

    let callRequest = await CallRequest.findById(req.params.id);
    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Booking request not found.' });
    }

    const isRecipient = callRequest.recipient.toString() === req.user.id; // Mentor / Expert
    const isRequester = callRequest.requester.toString() === req.user.id; // Student

    if (!isRecipient && !isRequester) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (['completed', 'rejected', 'cancelled'].includes(callRequest.status)) {
      return res.status(400).json({
        success: false,
        error: `This booking is already ${callRequest.status}.`,
      });
    }

    let notificationAction = null; // Tracks which email/push notification to fire after save

    // ====================================================================
    // 1. MENTOR (EXPERT) ACTIONS
    // ====================================================================
    if (isRecipient) {
      // CASE 1A: Mentor Accepts a Direct Slot Request ('pending' -> 'accepted')
      if (status === 'accepted') {
        if (!callRequest.scheduledAt) {
          return res.status(400).json({
            success: false,
            error: 'No scheduled time found on this request. Please propose a time slot instead.',
          });
        }

        const startMs = new Date(callRequest.scheduledAt).getTime();
        const durMins = Number(callRequest.durationMinutes) || 30;
        const endMs = startMs + durMins * 60 * 1000;

        if (startMs <= Date.now()) {
          return res.status(400).json({
            success: false,
            error: 'The requested time slot has already passed.',
          });
        }

        const conflict = await findOverlappingBooking(
          callRequest.recipient,
          startMs,
          endMs,
          callRequest._id
        );
        if (conflict) {
          return res.status(409).json({
            success: false,
            error: 'You already have another accepted session during this time window.',
          });
        }

        callRequest.status = 'accepted';
        callRequest.expertApprovedAt = new Date();
        callRequest.expiresAt = undefined;
        ensureBookingVideoSession(callRequest);
        notificationAction = 'mentor_accepted';
      }

      // CASE 1B: Mentor Rejects / Declines an Unpaid Request
      else if (status === 'rejected') {
        if (callRequest.paymentStatus === 'paid') {
          return res.status(400).json({
            success: false,
            error: 'This session is already paid. Use Emergency Cancel instead.',
          });
        }
        callRequest.status = 'rejected';
        callRequest.cancelledBy = 'expert';
        callRequest.cancelReason = cancelReason ? cancelReason.trim() : 'Declined by mentor';
        callRequest.cancelledAt = new Date();
        notificationAction = 'mentor_rejected';
      }

      // CASE 1C: Mentor Emergency Cancellation (Allowed up to 1 Hour Before scheduledAt!)
      else if (status === 'cancelled') {
        const startMs = callRequest.scheduledAt
          ? new Date(callRequest.scheduledAt).getTime()
          : 0;
        const oneHourMs = 60 * 60 * 1000;

        // Enforce 1-hour cutoff strictly for paid confirmed sessions
        if (callRequest.paymentStatus === 'paid' && startMs > 0) {
          const timeRemainingMs = startMs - Date.now();
          if (timeRemainingMs < oneHourMs) {
            return res.status(400).json({
              success: false,
              error:
                'Emergency cancellations are locked within 1 hour of the session start time.',
            });
          }
        }

        const wasPaid = callRequest.paymentStatus === 'paid';

        callRequest.status = 'cancelled';
        callRequest.cancelledBy = 'expert';
        callRequest.cancelReason =
          cancelReason && cancelReason.trim() !== ''
            ? cancelReason.trim()
            : 'Emergency cancellation by mentor';
        callRequest.cancelledAt = new Date();

        // If the student had already paid, route 100% of funds to Student's Refund Wallet!
        if (wasPaid) {
          callRequest.paymentStatus = 'failed';
          ensureBookingVideoSession(callRequest);
          callRequest.videoSession.status = 'expert_no_show';
          callRequest.videoSession.completionReason = 'expert_emergency_cancelled';
          callRequest.zoomMeeting.status = 'expert_no_show';
          callRequest.markModified('videoSession');
          callRequest.markModified('zoomMeeting');
          notificationAction = 'mentor_cancelled_paid';
        } else {
          notificationAction = 'mentor_cancelled_unpaid';
        }
      }

      // CASE 1D: Mentor Sends a Custom Time/Price Offer (Negotiation fallback)
      else if (status === 'offer_made') {
        if (!amount || !proposedSlots || proposedSlots.length === 0) {
          return res.status(400).json({
            success: false,
            error: 'Please provide a session fee and at least one time slot.',
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

        callRequest.amount = Math.round(Number(amount));
        callRequest.durationMinutes = validDuration;
        callRequest.proposedSlots = proposedSlots;
        callRequest.status = 'offer_made';
        notificationAction = 'mentor_offer_made';
      } else {
        return res.status(400).json({ success: false, error: 'Invalid mentor status update.' });
      }
    }

    // ====================================================================
    // 2. STUDENT (REQUESTER) ACTIONS
    // ====================================================================
    else if (isRequester) {
      // CASE 2A: Student Accepts a Custom Offer from Mentor
      if (status === 'accepted') {
        if (callRequest.status !== 'offer_made') {
          return res.status(400).json({
            success: false,
            error: 'This request is awaiting mentor approval first.',
          });
        }
        if (!scheduledAt) {
          return res.status(400).json({
            success: false,
            error: 'Please select one of the proposed time slots.',
          });
        }

        const selectedTimeMs = new Date(scheduledAt).getTime();
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
            error: 'This time slot overlaps with another confirmed booking.',
          });
        }

        callRequest.scheduledAt = new Date(selectedTimeMs);
        callRequest.scheduledEndAt = new Date(endTimeMs);
        callRequest.status = 'accepted';
        callRequest.expertApprovedAt = new Date();
        ensureBookingVideoSession(callRequest);
      }

      // CASE 2B: Student Withdraws an Unpaid Request
      else if (status === 'cancelled') {
        if (callRequest.paymentStatus === 'paid') {
          return res.status(400).json({
            success: false,
            error: 'Paid sessions cannot be cancelled by the student.',
          });
        }
        callRequest.status = 'cancelled';
        callRequest.cancelledBy = 'student';
        callRequest.cancelReason = cancelReason ? cancelReason.trim() : 'Withdrawn by student';
        callRequest.cancelledAt = new Date();
      } else {
        return res.status(403).json({
          success: false,
          error: 'Students can only withdraw unpaid requests or accept custom offers.',
        });
      }
    }

    await callRequest.save();

    callRequest = await CallRequest.findById(req.params.id)
      .populate('requester', 'name email slug profileImage')
      .populate('recipient', 'name email slug profileImage');

    // ====================================================================
    // 3. DISPATCH REAL-TIME PUSH + EMAIL NOTIFICATIONS
    // ====================================================================
    try {
      const student = callRequest.requester;
      const expert = callRequest.recipient;
      const istTime = formatIST(callRequest.scheduledAt);
      const dur = callRequest.durationMinutes || 30;

      if (notificationAction === 'mentor_accepted') {
        await Promise.all([
          sendPushNotification(
            student._id,
            '✅ Request Accepted! Complete Payment',
            `${expert.name} accepted your ${dur}m session for ${istTime}. Tap Bookings to pay ₹${callRequest.amount} and confirm!`
          ),
          sendEmail({
            email: student.email,
            subject: `✅ ${expert.name} Accepted Your Session Request!`,
            message: `Hi ${student.name.split(' ')[0]},\n\nGreat news! ${expert.name} has accepted your request for a ${dur}-minute 1:1 session ("${callRequest.topic}").\n\nScheduled Time: ${istTime} (IST)\nSession Fee: ₹${callRequest.amount}\n\n👉 Next Step: Open the YB Connect app -> Go to the "Bookings" tab -> Tap "Pay ₹${callRequest.amount} to Confirm" to lock in your video call.\n\nThank you,\nYour YB Connect Team`,
          }),
        ]);
      } else if (notificationAction === 'mentor_rejected') {
        await Promise.all([
          sendPushNotification(
            student._id,
            'Session Request Declined',
            `${expert.name} is unavailable for "${callRequest.topic}" at that time. No payment was charged.`
          ),
          sendEmail({
            email: student.email,
            subject: `Update on your session request with ${expert.name}`,
            message: `Hi ${student.name.split(' ')[0]},\n\n${expert.name} was unable to accept your session request for "${callRequest.topic}" (${istTime}).\nReason: ${callRequest.cancelReason}\n\nNo payment was charged. You are welcome to request another available slot or explore other mentors on YB Connect.\n\nThank you,\nYour YB Connect Team`,
          }),
        ]);
      } else if (notificationAction === 'mentor_cancelled_paid') {
        await Promise.all([
          sendPushNotification(
            student._id,
            '⚠️ Session Cancelled • 100% Refund Credited',
            `${expert.name} had an emergency and cancelled the session on ${istTime}. ₹${callRequest.amount} is now in your Refund Wallet.`
          ),
          sendEmail({
            email: student.email,
            subject: `⚠️ Session Cancelled by ${expert.name} - 100% Refund Credited`,
            message: `Hi ${student.name.split(' ')[0]},\n\nUnfortunately, ${expert.name} had to cancel your upcoming session ("${callRequest.topic}") scheduled for ${istTime} (IST).\n\nReason from Mentor: "${callRequest.cancelReason}"\n\n💰 100% Refund Issued: Your full payment of ₹${callRequest.amount} has been automatically credited to your YB Connect Refund Wallet. You can withdraw it directly from your Dashboard in the app.\n\nWe apologize for the inconvenience.\nYour YB Connect Team`,
          }),
        ]);
      } else if (notificationAction === 'mentor_cancelled_unpaid') {
        await sendPushNotification(
          student._id,
          'Session Cancelled by Mentor',
          `${expert.name} cancelled the unpaid session for "${callRequest.topic}".`
        );
      } else if (notificationAction === 'mentor_offer_made') {
        await Promise.all([
          sendPushNotification(
            student._id,
            'Offer Received! 🔔',
            `${expert.name} sent you an offer of ₹${callRequest.amount} (${dur}m). Tap to review and pick a slot!`
          ),
          sendEmail({
            email: student.email,
            subject: `🔔 Action Required: ${expert.name} sent you an offer!`,
            message: `Hi ${student.name.split(' ')[0]},\n\n${expert.name} reviewed your request and proposed time slots for ₹${callRequest.amount} (${dur} mins).\n\nOpen the YB Connect app -> Go to "Bookings" to select a time and pay.\n\nThank you,\nYour YB Connect Team`,
          }),
        ]);
      }
    } catch (notifyErr) {
      console.error('⚠️ Notification dispatch warning:', notifyErr.message);
    }

    res.status(200).json({ success: true, data: callRequest });
  } catch (error) {
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

exports.getExpertReviews = async (req, res, next) => {
  try {
    const { expertId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(expertId)) {
      return res.status(400).json({ success: false, error: 'Invalid expert ID' });
    }

    const rawReviews = await CallRequest.collection.find({
      recipient: new mongoose.Types.ObjectId(expertId),
      status: 'completed',
      $or: [
        { 'review.rating': { $exists: true } },
        { 'zoomMeeting.review.rating': { $exists: true } },
      ],
    }).toArray();

    const User = require('../models/User');
    const Profile = require('../models/Profile');
    let reviews = await Promise.all(
      rawReviews.map(async (item) => {
        const reqUser = await User.findById(item.requester).select('name slug').lean();
        const reqProfile = await Profile.findOne({ user: item.requester }).select('profileImage').lean();
        return {
          ...item,
          requester: {
            _id: item.requester,
            name: reqUser?.name || 'User',
            slug: reqUser?.slug || '',
            profileImage: reqProfile?.profileImage || 'default-avatar.png',
          },
        };
      })
    );

    reviews = reviews
      .map((reqItem) => {
        if (reqItem.zoomMeeting && reqItem.zoomMeeting.review && !reqItem.review) {
          reqItem.review = reqItem.zoomMeeting.review;
        }
        return reqItem;
      })
      .sort((a, b) => {
        const dateA = new Date(a.review?.submittedAt || a.zoomMeeting?.review?.submittedAt || 0).getTime();
        const dateB = new Date(b.review?.submittedAt || b.zoomMeeting?.review?.submittedAt || 0).getTime();
        return dateB - dateA;
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