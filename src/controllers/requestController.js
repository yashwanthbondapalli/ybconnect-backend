const CallRequest = require('../models/CallRequest');
const User = require('../models/User');
const { createZoomMeeting } = require('../utils/zoomHelper');

exports.createCallRequest = async (req, res, next) => {
  try {
    const { recipientId, topic, message } = req.body;
    if (req.user.id === recipientId) return res.status(400).json({ success: false, error: "Cannot request yourself." });

    const callRequest = await CallRequest.create({
      requester: req.user.id,
      recipient: recipientId,
      topic,
      message
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
      .lean(); // .lean() converts Mongoose documents to plain JS objects so we can edit them

    // 🚨 THE GATEKEEPER: Hide Zoom URLs from unpaid students
    requests = requests.map(reqData => {
      // If the person asking is the Student AND they haven't paid yet
      if (reqData.requester._id.toString() === req.user.id && reqData.paymentStatus !== 'paid') {
        if (reqData.zoomMeeting) {
          reqData.zoomMeeting.joinUrl = 'hidden_until_paid';
          reqData.zoomMeeting.startUrl = 'hidden';
        }
      }
      
      // Always hide the Expert's private startUrl from the Student, even if paid
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
    const { status, scheduledAt, amount, duration } = req.body; 
    let callRequest = await CallRequest.findById(req.params.id);

    if (!callRequest) return res.status(404).json({ success: false, error: 'Request not found' });
    
    // 🚨 1. SMART AUTH CHECK: Determine who is making the request
    const isRecipient = callRequest.recipient.toString() === req.user.id; // The Expert
    const isRequester = callRequest.requester.toString() === req.user.id; // The Student

    if (!isRecipient && !isRequester) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    // 🚨 2. STUDENT RULES: Students can ONLY cancel, and ONLY if they haven't paid
    if (isRequester) {
      if (status !== 'cancelled') {
        return res.status(403).json({ success: false, error: 'Students can only cancel requests.' });
      }
      if (callRequest.paymentStatus === 'paid') {
        return res.status(400).json({ success: false, error: 'Cannot cancel a session that is already paid. Please contact support.' });
      }
    }

    // 3. Prevent modifying completely closed tickets
    if (['completed', 'rejected', 'cancelled'].includes(callRequest.status)) {
       return res.status(400).json({ success: false, error: `This request is already ${callRequest.status}.` });
    }

    // 4. Update basic fields
    callRequest.status = status;
    if (scheduledAt) callRequest.scheduledAt = scheduledAt;
    if (amount) callRequest.amount = amount;
    
    // 5. ZOOM LOGIC (Only runs if the EXPERT is accepting)
    if (isRecipient && (status === 'accepted' || status === 'confirmed') && callRequest.scheduledAt) {
      if (!callRequest.zoomMeeting || !callRequest.zoomMeeting.joinUrl) {
        try {
          const zoomData = await createZoomMeeting(
            callRequest.recipient, 
            callRequest.topic || 'BacktoBase Consultation', 
            callRequest.scheduledAt, 
            duration || 30 
          );

          callRequest.zoomMeeting = {
            meetingId: zoomData.meetingId,
            startUrl: zoomData.startUrl, 
            joinUrl: zoomData.joinUrl,   
            status: 'waiting'
          };
        } catch (zoomError) {
          console.error("Zoom Generation Failed:", zoomError.message);
          return res.status(500).json({ 
            success: false, 
            error: 'Failed to generate Zoom link. Ensure your Zoom account is connected.' 
          });
        }
      }
    }

    // 6. Save everything to MongoDB
    await callRequest.save();
    
    // 7. Re-fetch to return to frontend
    callRequest = await CallRequest.findById(req.params.id)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    res.status(200).json({ success: true, data: callRequest });
  } catch (error) { 
    next(error); 
  }
};