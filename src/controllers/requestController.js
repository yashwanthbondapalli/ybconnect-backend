const CallRequest = require('../models/CallRequest');
const User = require('../models/User');
// 🚨 ADD THIS LINE:
const Profile = require('../models/Profile');
const sendEmail = require('../utils/emailHelper');
const sendPushNotification = require('../utils/pushHelper');



// ==========================================
// CASE 1: USER A REQUESTS EXPERT B
// ==========================================
exports.createCallRequest = async (req, res, next) => {
  try {
    const { recipientId, topic, message, budgetMin, budgetMax } = req.body;
    
    if (req.user.id === recipientId) return res.status(400).json({ success: false, error: "Cannot request yourself." });

    const callRequest = await CallRequest.create({
      requester: req.user.id,
      recipient: recipientId,
      topic,
      message,
      budget: { min: budgetMin, max: budgetMax }
    });

    // 🚨 TRIGGER PUSH NOTIFICATION TO EXPERT
    await sendPushNotification(
      recipientId, 
      "New Mentorship Request! 🚀", 
      `Someone wants to book a session with you for ${topic}. Check your appointments!`
    );

    res.status(201).json({ success: true, data: callRequest });
  } catch (error) { 
    next(error); 
  }
};

exports.getRequests = async (req, res, next) => {
  try {
    let requests = await CallRequest.find({
      $or: [{ requester: req.user.id }, { recipient: req.user.id }]
    })
      .populate('requester', 'name email')
      .populate('recipient', 'name email')
      .sort({ createdAt: -1 })
      .lean(); 

    // THE GATEKEEPER: Hide Zoom URLs from unpaid students
    requests = requests.map(reqData => {
      if (reqData.requester._id.toString() === req.user.id && reqData.paymentStatus !== 'paid') {
        if (reqData.zoomMeeting) {
          reqData.zoomMeeting.joinUrl = 'hidden_until_paid';
          reqData.zoomMeeting.startUrl = 'hidden';
        }
      }
      if (reqData.requester._id.toString() === req.user.id && reqData.zoomMeeting) {
         reqData.zoomMeeting.startUrl = 'hidden';
      }
      return reqData;
    });

    res.status(200).json({ success: true, data: requests });
  } catch (error) { 
    next(error); 
  }
};

exports.updateRequestStatus = async (req, res, next) => {
  try {
    // 🚀 NEW: We now accept proposedSlots for the negotiation
    const { status, scheduledAt, amount, proposedSlots } = req.body; 
    let callRequest = await CallRequest.findById(req.params.id);

    if (!callRequest) return res.status(404).json({ success: false, error: 'Request not found' });
    
    const isRecipient = callRequest.recipient.toString() === req.user.id; // Expert
    const isRequester = callRequest.requester.toString() === req.user.id; // Student

    if (!isRecipient && !isRequester) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // Prevent modifying completely closed tickets
    if (['completed', 'rejected', 'cancelled'].includes(callRequest.status)) {
       return res.status(400).json({ success: false, error: `This request is already ${callRequest.status}.` });
    }

    if (isRecipient && status === 'offer_made') {
      if (!amount || !proposedSlots || proposedSlots.length === 0) {
        return res.status(400).json({ success: false, error: 'You must provide a price and at least one proposed time slot to make an offer.' });
      }

      // 🚨 FIX 1: Check if the Expert has actually connected their Zoom account!
      const expertProfile = await Profile.findOne({ user: req.user.id });
      if (!expertProfile || !expertProfile.zoomCredentials || !expertProfile.zoomCredentials.isConnected) {
        return res.status(400).json({ 
          success: false, 
          error: 'Action Required: You must connect your Zoom account in your Profile Settings before you can accept sessions.' 
        });
      }

       if (
    !Array.isArray(proposedSlots) ||
    proposedSlots.length === 0 ||
    proposedSlots.length > 3
  ) {
    return res.status(400).json({
      success: false,
      error: 'Please provide between 1 and 3 proposed time slots.'
    });
  }

  const now = Date.now();

  const parsedSlots = proposedSlots.map(slot => new Date(slot));

  // 4. Every slot must be a valid date
  if (parsedSlots.some(date => Number.isNaN(date.getTime()))) {
    return res.status(400).json({
      success: false,
      error: 'One or more proposed time slots are invalid.'
    });
  }

  // 5. No past slots
  if (parsedSlots.some(date => date.getTime() <= now)) {
    return res.status(400).json({
      success: false,
      error: 'Proposed time slots must be in the future.'
    });
  }

  // 6. No duplicate slots
  const uniqueSlotTimes = new Set(
    parsedSlots.map(date => date.getTime())
  );

  if (uniqueSlotTimes.size !== parsedSlots.length) {
    return res.status(400).json({
      success: false,
      error: 'Proposed time slots cannot contain duplicates.'
    });
  }

      callRequest.amount = amount;
      callRequest.proposedSlots = proposedSlots;
      callRequest.status = 'offer_made';
    }
    // Expert can also reject directly
    else if (isRecipient && status === 'rejected') {
      callRequest.status = 'rejected';
    }

    // ==========================================
    // 🚨 STUDENT LOGIC: Accepting the Offer & Paying
    // ==========================================
    if (isRequester) {
      if (status === 'accepted') {
        if (callRequest.status !== 'offer_made') {
          return res.status(400).json({ success: false, error: 'You cannot accept a session that has not been offered yet.' });
        }
        if (!scheduledAt) {
          return res.status(400).json({ success: false, error: 'You must select one of the proposed time slots to confirm the session.' });
        }

        const selectedTime = new Date(scheduledAt).getTime();

const isValidProposedSlot = callRequest.proposedSlots.some(
  slot => new Date(slot).getTime() === selectedTime
);

if (!isValidProposedSlot) {
  return res.status(400).json({
    success: false,
    error: 'Invalid time slot. Please select one of the time slots proposed by the expert.'
  });
}
        
        // 10-MINUTE BUFFER CHECK: Ensure the student isn't picking a slot that is already happening
        const scheduledTimeMs = new Date(scheduledAt).getTime();
        const tenMinsFromNowMs = Date.now() + (10 * 60 * 1000);
        if (scheduledTimeMs < tenMinsFromNowMs) {
          return res.status(400).json({ success: false, error: 'The selected time slot is too soon. Please select a time at least 10 minutes from now.' });
        }

        callRequest.scheduledAt = scheduledAt;
        callRequest.status = 'accepted';
      } 
      // Student can cancel at any time before payment
      else if (status === 'cancelled') {
        if (callRequest.paymentStatus === 'paid') {
          return res.status(400).json({ success: false, error: 'Cannot cancel a session that is already paid.' });
        }
        callRequest.status = 'cancelled';
      } 
      else {
        return res.status(403).json({ success: false, error: 'Students can only accept offers or cancel requests.' });
      }
    }

// Save everything to MongoDB
    await callRequest.save();
    
    // Re-fetch to return to frontend
    callRequest = await CallRequest.findById(req.params.id)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    // 🚨 FIX: SEND THE EMAIL!
// 🚨 FIX: SEND BOTH EMAIL AND PUSH NOTIFICATION!
    if (callRequest.status === 'offer_made') {
      try {
        const student = callRequest.requester;
        const expert = callRequest.recipient;
        
        // 1. Send Email (Your existing code)
        await sendEmail({
          email: student.email,
          subject: `🔔 Action Required: ${expert.name} sent you an offer!`,
          message: `Hi ${student.name.split(' ')[0]},\n\nGood news! ${expert.name} has reviewed your mentorship request and made you an offer for ₹${callRequest.amount}.\n\nThey have proposed a few available time slots for the session. Please log in to the YB Connect app, go to your Appointments tab, and tap "Review & Book" to pick your preferred time and complete the payment.\n\nThank you,\nYour YB Connect Team`
        });
        
        // 2. 🚨 Send Push Notification to Student
        await sendPushNotification(
          student._id,
          "Offer Received! 🔔",
          `${expert.name} sent you an offer of ₹${callRequest.amount}. Tap to review and pick a time slot!`
        );

      } catch (err) {
        console.error("⚠️ Failed to send offer notifications:", err.message);
      }
    }

    res.status(200).json({ success: true, data: callRequest });
  } catch (error) { 
    next(error); 
  }
};

// ==========================================
// 🚀 NEW: INSTANT BOOKING CART LOCK
// ==========================================
exports.createInstantHold = async (req, res, next) => {
  try {
    const { recipientId, topic, message, scheduledAt } = req.body;

    if (req.user.id === recipientId) {
      return res.status(400).json({ success: false, error: "Cannot request yourself." });
    }

    // 1. Fetch Expert's Profile to get their strict hourly rate
    const expertProfile = await Profile.findOne({ user: recipientId });
    if (!expertProfile) {
      return res.status(404).json({ success: false, error: 'Expert not found.' });
    }
    if (!expertProfile.zoomCredentials || !expertProfile.zoomCredentials.isConnected) {
      return res.status(400).json({ success: false, error: 'This expert has not connected their Zoom account yet.' });
    }

    const amount = expertProfile.hourlyRate; // Lock in the price!

    // 2. 🚨 DOUBLE-BOOKING PROTECTION
    const slotTime = new Date(scheduledAt);
    const overlappingRequest = await CallRequest.findOne({
      recipient: recipientId,
      scheduledAt: slotTime,
      status: { $in: ['holding', 'accepted'] }
    });

    if (overlappingRequest) {
      return res.status(409).json({ success: false, error: 'Someone else just reserved this exact slot! Please pick another time.' });
    }

    // 3. CREATE THE 10-MINUTE LOCK
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // Self-destructs in 10 mins if unpaid

    const callRequest = await CallRequest.create({
      requester: req.user.id,
      recipient: recipientId,
      topic,
      message,
      amount: amount, 
      scheduledAt: slotTime,
      status: 'holding',     // Marks it as a temporary cart hold
      expiresAt: expiresAt   // The ticking timer
    });

    res.status(201).json({ success: true, data: callRequest });
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

    if (!request) return res.status(404).json({ success: false, error: 'Request not found' });
    
    // Security: Only the student who booked the session can review it
    if (request.requester.toString() !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Only the student can leave a review.' });
    }

    if (request.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'You can only review completed sessions.' });
    }

    // 🚨 THE FIX: Add strict: false to FORCE MongoDB to save the review!
    const updatedRequest = await CallRequest.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          review: {
            rating: Number(rating),
            feedback: feedback || '',
            submittedAt: Date.now()
          }
        }
      },
      { new: true, strict: false } // 👈 strict: false is the magic key!
    );

    res.status(200).json({ success: true, data: updatedRequest });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all reviews for a specific expert
// @route   GET /api/v1/requests/expert/:expertId/reviews
// @desc    Get all reviews for a specific expert
// @route   GET /api/v1/requests/expert/:expertId/reviews
exports.getExpertReviews = async (req, res, next) => {
  try {
    const { expertId } = req.params;

    // 🚨 FIX: Search BOTH the root level and inside zoomMeeting!
    let reviews = await CallRequest.find({
      recipient: expertId,
      status: 'completed',
      $or: [
        { 'review.rating': { $exists: true } },
        { 'zoomMeeting.review.rating': { $exists: true } }
      ]
    })
    .populate('requester', 'name email slug profileImage') 
    .sort({ 'review.submittedAt': -1, 'zoomMeeting.review.submittedAt': -1 }) 
    .lean();

    // 🚨 FIX: Normalize the data so the frontend always finds it in the same place
    reviews = reviews.map(req => {
      if (req.zoomMeeting && req.zoomMeeting.review && !req.review) {
        req.review = req.zoomMeeting.review;
      }
      return req;
    });

    let totalRating = 0;
    let averageRating = 0;
    
    if (reviews.length > 0) {
      totalRating = reviews.reduce((sum, req) => sum + (req.review?.rating || 0), 0);
      averageRating = (totalRating / reviews.length).toFixed(1); 
    }

    res.status(200).json({
      success: true,
      count: reviews.length,
      stats: {
        averageRating: Number(averageRating),
        totalReviews: reviews.length
      },
      data: reviews
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a submitted review (Student only)
// @desc    Delete a submitted review (Student only)
// @route   DELETE /api/v1/requests/:id/review
exports.deleteReview = async (req, res, next) => {
  try {
    const request = await CallRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    // Security Check: Ensure ONLY the student who wrote the review can delete it
    if (request.requester.toString() !== req.user.id) {
      return res.status(403).json({ success: false, error: 'You can only delete your own reviews.' });
    }

    // 🚨 FIX: We must use strict: false here too, AND delete it from everywhere!
    const updatedRequest = await CallRequest.findByIdAndUpdate(
      req.params.id,
      { 
        $unset: { 
          review: 1, 
          "zoomMeeting.review": 1 
        } 
      }, 
      { new: true, strict: false } // 👈 strict: false forces MongoDB to obey the delete!
    );

    res.status(200).json({ success: true, data: updatedRequest });
  } catch (error) {
    next(error);
  }
};



// ==========================================
// 🚀 NEW: SEND NEON NUDGE (MEETING REMINDER)
// ==========================================
exports.sendNudge = async (req, res, next) => {
  try {
    const { customMessage } = req.body; // 🚨 NEW: Extract the custom message!
    const request = await CallRequest.findById(req.params.id)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    if (!request) return res.status(404).json({ success: false, error: 'Request not found' });

    if (request.nudgesSent >= 5) {
      return res.status(400).json({ success: false, error: 'Maximum reminders sent.' });
    }

    const isRequester = request.requester._id.toString() === req.user.id;
    const sender = isRequester ? request.requester : request.recipient;
    const receiver = isRequester ? request.recipient : request.requester;

    // 🚨 NEW: Construct the dynamic message
    const senderFirstName = sender.name.split(' ')[0];
    const defaultMsg = `${senderFirstName} is waiting for you in the Zoom room. Please join ASAP!`;
    const finalNotificationMsg = customMessage && customMessage.trim() !== '' 
      ? `${senderFirstName} says: "${customMessage}"` 
      : defaultMsg;

    request.nudgesSent = (request.nudgesSent || 0) + 1;
    await request.save();

    // Send Push Notification
    try {
      await sendPushNotification(
        receiver._id,
        "Meeting Reminder! ⏰",
        finalNotificationMsg
      );
    } catch (pushErr) {}

    // Create In-App Notification
    try {
      await Notification.create({
        user: receiver._id,
        title: "Meeting Reminder! ⏰",
        message: finalNotificationMsg
      });
    } catch (dbErr) {}

    // Send Urgent Email
    try {
      await sendEmail({
        email: receiver.email,
        subject: `🔔 Urgent: ${senderFirstName} sent you a reminder!`,
        message: `Hi ${receiver.name.split(' ')[0]},\n\n${finalNotificationMsg}\n\nThank you,\nYour YB Connect Team`
      });
    } catch (emailErr) {}

    res.status(200).json({ success: true, nudgesSent: request.nudgesSent });
  } catch (error) {
    next(error);
  }
};