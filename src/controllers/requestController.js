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