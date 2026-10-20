// backend/src/controllers/livekitController.js
const CallRequest = require('../models/CallRequest');
const Profile = require('../models/Profile');
const {
  ensureBookingVideoSession,
  createParticipantToken,
  verifyLiveKitWebhook,
  flushAttendanceTimers,
  recordParticipantJoin,
  recordParticipantLeave,
  evaluateSessionState,
} = require('../utils/livekitHelper');

/**
 * @desc   Issue a short-lived LiveKit token for an authorized participant
 * @route  POST /api/v1/livekit/token
 * @access Private (Protected by JWT)
 */
exports.getCallToken = async (req, res, next) => {
  try {
    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ success: false, error: 'Booking requestId is required.' });
    }

    const callRequest = await CallRequest.findById(requestId)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Appointment not found.' });
    }

    const userIdStr = req.user._id.toString();
    const isRequester = callRequest.requester._id.toString() === userIdStr;
    const isRecipient = callRequest.recipient._id.toString() === userIdStr;

    // 1. Strict IDOR Authorization Check
    if (!isRequester && !isRecipient) {
      return res.status(403).json({
        success: false,
        error: 'Security Alert: You are not a participant of this session.',
      });
    }

    // 2. Validate Booking & Payment Status
    if (['cancelled', 'rejected'].includes(callRequest.status)) {
      return res.status(400).json({
        success: false,
        error: `This appointment has been ${callRequest.status}.`,
      });
    }

    if (!['paid', 'payout_ready', 'payout_processing'].includes(callRequest.paymentStatus)) {
      return res.status(402).json({
        success: false,
        error: 'Payment must be completed before joining the video session.',
      });
    }

    if (
      callRequest.videoSession?.status === 'expert_no_show' ||
      callRequest.videoSession?.status === 'student_no_show' ||
      callRequest.zoomMeeting?.status === 'expert_no_show' ||
      callRequest.zoomMeeting?.status === 'student_no_show'
    ) {
      return res.status(400).json({
        success: false,
        error: 'This session has already been closed due to a no-show.',
      });
    }

    // 3. Validate Session Timing Window (Unlocks 5 mins before start, closes 30 mins after scheduled end)
    const nowMs = Date.now();
    const scheduledStartMs = new Date(callRequest.scheduledAt).getTime();
    const durationMinutes = Number(callRequest.durationMinutes) || 30;
    const scheduledEndMs = callRequest.scheduledEndAt
      ? new Date(callRequest.scheduledEndAt).getTime()
      : scheduledStartMs + durationMinutes * 60 * 1000;

    const earliestJoinMs = scheduledStartMs - 5 * 60 * 1000; // 5 minutes before start
    const latestJoinMs = scheduledEndMs + 30 * 60 * 1000;    // 30 minutes grace after scheduled end

    if (nowMs < earliestJoinMs) {
      const minsUntilUnlock = Math.ceil((earliestJoinMs - nowMs) / 60000);
      return res.status(400).json({
        success: false,
        error: `Video room unlocks 5 minutes before the session starts (in ~${minsUntilUnlock} min).`,
      });
    }

    if (nowMs > latestJoinMs) {
      return res.status(400).json({
        success: false,
        error: 'The scheduled window for this session has ended.',
      });
    }

    // 4. Fetch both profiles for display avatars & designations
    const [expertProfile, studentProfile] = await Promise.all([
      Profile.findOne({ user: callRequest.recipient._id }).select('designation companyName profileImage').lean(),
      Profile.findOne({ user: callRequest.requester._id }).select('major university profileImage').lean(),
    ]);

    const { roomName } = ensureBookingVideoSession(callRequest);
    const participantRole = isRecipient ? 'expert' : 'student';
    const participantIdentity = `${participantRole}_${userIdStr}`;
    const participantName = isRecipient ? callRequest.recipient.name : callRequest.requester.name;

    // Record initial join intent
    await recordParticipantJoin(callRequest, participantRole, new Date());

    // 5. Generate short-lived room-scoped LiveKit token
    const token = await createParticipantToken({
      roomName,
      participantIdentity,
      participantName,
      metadata: {
        requestId: callRequest._id.toString(),
        userId: userIdStr,
        role: participantRole,
        name: participantName,
      },
    });

    return res.status(200).json({
      success: true,
      data: {
        token,
        wsUrl: process.env.LIVEKIT_URL || '',
        roomName,
        role: participantRole,
        participantIdentity,
        session: {
          requestId: callRequest._id,
          topic: callRequest.topic,
          scheduledAt: callRequest.scheduledAt,
          scheduledEndAt: new Date(scheduledEndMs).toISOString(),
          durationMinutes,
          amount: callRequest.amount,
          expert: {
            _id: callRequest.recipient._id,
            name: callRequest.recipient.name,
            designation: expertProfile?.designation || 'Verified Mentor',
            companyName: expertProfile?.companyName || '',
            profileImage: expertProfile?.profileImage || 'default-avatar.png',
          },
          student: {
            _id: callRequest.requester._id,
            name: callRequest.requester.name,
            designation: studentProfile?.major || 'Mentee',
            profileImage: studentProfile?.profileImage || 'default-avatar.png',
          },
        },
      },
    });
  } catch (error) {
    console.error('LiveKit Token Error:', error.message);
    next(error);
  }
};

/**
 * @desc   Record in-app call lifecycle events (join, heartbeat, leave)
 * @route  POST /api/v1/livekit/session-event
 * @access Private
 */
exports.reportSessionEvent = async (req, res, next) => {
  try {
    const { requestId, action } = req.body; // action: 'join' | 'heartbeat' | 'leave'
    if (!requestId || !action) {
      return res.status(400).json({ success: false, error: 'requestId and action are required.' });
    }

    const callRequest = await CallRequest.findById(requestId);
    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }

    const userIdStr = req.user._id.toString();
    const isRequester = callRequest.requester.toString() === userIdStr;
    const isRecipient = callRequest.recipient.toString() === userIdStr;

    if (!isRequester && !isRecipient) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const role = isRecipient ? 'expert' : 'student';
    const now = new Date();

    if (action === 'join') {
      await recordParticipantJoin(callRequest, role, now);
    } else if (action === 'heartbeat') {
      ensureBookingVideoSession(callRequest);
      if (role === 'expert') {
        callRequest.videoSession.expertJoinedAt = callRequest.videoSession.expertJoinedAt || now;
        callRequest.videoSession.expertLastJoinedAt = callRequest.videoSession.expertLastJoinedAt || now;
        callRequest.videoSession.expertLastSeenAt = now;
      } else {
        callRequest.videoSession.studentJoinedAt = callRequest.videoSession.studentJoinedAt || now;
        callRequest.videoSession.studentLastJoinedAt = callRequest.videoSession.studentLastJoinedAt || now;
        callRequest.videoSession.studentLastSeenAt = now;
      }

      if (
        callRequest.videoSession.expertLastJoinedAt &&
        callRequest.videoSession.studentLastJoinedAt &&
        !callRequest.videoSession.overlapStartedAt
      ) {
        callRequest.videoSession.overlapStartedAt = now;
      }

      flushAttendanceTimers(callRequest, now);
      await evaluateSessionState(callRequest, { isFinalCheck: false, referenceTime: now });
      callRequest.markModified('videoSession');
      callRequest.markModified('zoomMeeting');
      await callRequest.save();
    } else if (action === 'leave') {
      await recordParticipantLeave(callRequest, role, now);
    }

    return res.status(200).json({
      success: true,
      data: {
        status: callRequest.status,
        paymentStatus: callRequest.paymentStatus,
        videoSession: callRequest.videoSession,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc   Authoritative LiveKit Server Webhook Handler
 * @route  POST /api/v1/livekit/webhook
 * @access Public (Verified via LiveKit Webhook Signature)
 */
exports.livekitWebhook = async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    let event;
    try {
      event = await verifyLiveKitWebhook(rawBody, authHeader);
    } catch (verifyErr) {
      console.warn('🚨 LiveKit Webhook signature rejected:', verifyErr.message);
      return res.status(401).send('Invalid LiveKit webhook signature');
    }

    const eventType = event.event;
    const eventId = event.id;
    const roomName = event.room?.name;

    if (!roomName || !roomName.startsWith('yb_session_')) {
      return res.status(200).send('Ignored non-YB room');
    }

    const callRequest = await CallRequest.findOne({
      $or: [
        { 'videoSession.roomName': roomName },
        { 'zoomMeeting.meetingId': roomName },
      ],
    });

    if (!callRequest) {
      return res.status(200).send('Session record not found');
    }

    ensureBookingVideoSession(callRequest);

    // Idempotency Guard: Ignore duplicate webhook deliveries
    if (eventId && callRequest.videoSession.processedWebhookIds?.includes(eventId)) {
      return res.status(200).send('Duplicate webhook ignored');
    }
    if (eventId) {
      callRequest.videoSession.processedWebhookIds.push(eventId);
    }

    const identity = event.participant?.identity || '';
    const role = identity.startsWith('expert_')
      ? 'expert'
      : identity.startsWith('student_')
      ? 'student'
      : null;

    const eventTime = event.createdAt ? new Date(Number(event.createdAt) * 1000) : new Date();

    if (eventType === 'participant_joined' && role) {
      await recordParticipantJoin(callRequest, role, eventTime);
    } else if (eventType === 'participant_left' && role) {
      await recordParticipantLeave(callRequest, role, eventTime);
    } else if (eventType === 'room_finished') {
      flushAttendanceTimers(callRequest, eventTime);
      callRequest.videoSession.expertLastJoinedAt = null;
      callRequest.videoSession.studentLastJoinedAt = null;
      callRequest.videoSession.overlapStartedAt = null;
      await evaluateSessionState(callRequest, { isFinalCheck: false, referenceTime: eventTime });
      callRequest.markModified('videoSession');
      callRequest.markModified('zoomMeeting');
      await callRequest.save();
    }

    return res.status(200).send('LiveKit webhook processed');
  } catch (error) {
    console.error('LiveKit Webhook Error:', error);
    return res.status(500).send('Webhook processing failed');
  }
};