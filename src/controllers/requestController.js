const CallRequest = require('../models/CallRequest');
const User = require('../models/User');
// 🚨 ADD THIS LINE:
const sendEmail = require('../utils/emailHelper');

exports.createCallRequest = async (req, res, next) => {
  try {
    // 🚀 NEW: Accept budgetMin and budgetMax from the student
    const { recipientId, topic, message, budgetMin, budgetMax } = req.body;
    
    if (req.user.id === recipientId) return res.status(400).json({ success: false, error: "Cannot request yourself." });

    const callRequest = await CallRequest.create({
      requester: req.user.id,
      recipient: recipientId,
      topic,
      message,
      budget: {
        min: budgetMin,
        max: budgetMax
      }
    });

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

    // ==========================================
    // 🚨 EXPERT LOGIC: Making an Offer
    // ==========================================
    if (isRecipient && status === 'offer_made') {
      if (!amount || !proposedSlots || proposedSlots.length === 0) {
        return res.status(400).json({ success: false, error: 'You must provide a price and at least one proposed time slot to make an offer.' });
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
    if (isRecipient && callRequest.status === 'offer_made') {
      try {
        const student = callRequest.requester;
        const expert = callRequest.recipient;
        const sendEmail = require('../utils/emailHelper'); 
        
        await sendEmail({
          email: student.email,
          subject: `🔔 Action Required: ${expert.name} sent you an offer!`,
          message: `Hi ${student.name.split(' ')[0]},\n\nGood news! ${expert.name} has reviewed your mentorship request and made you an offer for ₹${callRequest.amount}.\n\nThey have proposed a few available time slots for the session. Please log in to the YB Connect app, go to your Appointments tab, and tap "Review & Book" to pick your preferred time and complete the payment.\n\nThank you,\nYour YB Connect Team`
        });
        console.log(`✅ Offer email successfully sent to ${student.email}`);
      } catch (emailErr) {
        console.error("⚠️ Failed to send offer email:", emailErr.message);
      }
    }

    res.status(200).json({ success: true, data: callRequest });
  } catch (error) { 
    next(error); 
  }
};