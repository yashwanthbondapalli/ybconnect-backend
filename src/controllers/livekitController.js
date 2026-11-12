// backend/src/controllers/livekitController.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const CallRequest = require('../models/CallRequest');
const Profile = require('../models/Profile');

let livekitSdk = null;
try {
  livekitSdk = require('livekit-server-sdk');
} catch (e) {
  // Fallback to RFC-compliant JWT signing if SDK is ESM-only
}

const HEARTBEAT_TIMEOUT_MS = 65 * 1000;
const HEARTBEAT_GRACE_CREDIT_MS = 20 * 1000;

const getRoomNameForRequest = (requestId) => {
  return `yb_session_${String(requestId).trim()}`;
};

const ensureBookingVideoSession = (callRequest) => {
  const roomName = getRoomNameForRequest(callRequest._id);
  const inAppMarker = `livekit://${roomName}`;

  if (!callRequest.videoSession) {
    callRequest.videoSession = {};
  }
  callRequest.videoProvider = 'livekit';
  callRequest.videoSession.roomName = roomName;
  if (!callRequest.videoSession.status) {
    callRequest.videoSession.status = 'waiting';
  }

  if (
    Array.isArray(callRequest.videoSession.processedWebhookIds) &&
    callRequest.videoSession.processedWebhookIds.length > 100
  ) {
    callRequest.videoSession.processedWebhookIds =
      callRequest.videoSession.processedWebhookIds.slice(-100);
  }

  if (!callRequest.zoomMeeting) {
    callRequest.zoomMeeting = {};
  }
  callRequest.zoomMeeting.meetingId = roomName;
  callRequest.zoomMeeting.startUrl = inAppMarker;
  callRequest.zoomMeeting.joinUrl = inAppMarker;
  if (!callRequest.zoomMeeting.status) {
    callRequest.zoomMeeting.status = 'waiting';
  }

  return { roomName, inAppMarker };
};

const createParticipantToken = async ({
  roomName,
  participantIdentity,
  participantName,
  metadata = {},
  ttlSeconds = 2 * 60 * 60,
}) => {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LiveKit credentials are missing in .env');
  }

  const metadataStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

  if (livekitSdk && livekitSdk.AccessToken) {
    const at = new livekitSdk.AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      name: participantName,
      metadata: metadataStr,
      ttl: ttlSeconds,
    });
    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return await at.toJwt();
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    iss: apiKey,
    sub: participantIdentity,
    nbf: nowSec - 10,
    exp: nowSec + ttlSeconds,
    name: participantName,
    metadata: metadataStr,
    video: {
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };

  return jwt.sign(payload, apiSecret, { algorithm: 'HS256' });
};

const verifyLiveKitWebhook = async (rawBody, authHeader) => {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error('LiveKit credentials not configured');
  }
  if (!authHeader) {
    throw new Error('Missing Authorization header on LiveKit webhook');
  }

  if (livekitSdk && livekitSdk.WebhookReceiver) {
    const receiver = new livekitSdk.WebhookReceiver(apiKey, apiSecret);
    return await receiver.receive(rawBody, authHeader);
  }

  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const decoded = jwt.verify(token, apiSecret, { issuer: apiKey, algorithms: ['HS256'] });
  const bodyHashHex = crypto.createHash('sha256').update(rawBody).digest('hex');
  const bodyHashBase64 = crypto.createHash('sha256').update(rawBody).digest('base64');

  if (decoded.sha256 && decoded.sha256 !== bodyHashHex && decoded.sha256 !== bodyHashBase64) {
    throw new Error('LiveKit webhook body hash mismatch');
  }

  return typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
};

const flushAttendanceTimers = (callRequest, referenceTime = new Date()) => {
  const now = new Date(referenceTime);
  const nowMs = now.getTime();
  const vs = callRequest.videoSession || {};
  const scheduledStartMs = callRequest.scheduledAt ? new Date(callRequest.scheduledAt).getTime() : 0;

  let expertEffectiveNow = now;
  let expertTimedOut = false;
  if (vs.expertLastJoinedAt && vs.expertLastSeenAt) {
    const lastSeenMs = new Date(vs.expertLastSeenAt).getTime();
    if (nowMs - lastSeenMs > HEARTBEAT_TIMEOUT_MS) {
      expertEffectiveNow = new Date(Math.min(nowMs, lastSeenMs + HEARTBEAT_GRACE_CREDIT_MS));
      expertTimedOut = true;
    }
  }

  let studentEffectiveNow = now;
  let studentTimedOut = false;
  if (vs.studentLastJoinedAt && vs.studentLastSeenAt) {
    const lastSeenMs = new Date(vs.studentLastSeenAt).getTime();
    if (nowMs - lastSeenMs > HEARTBEAT_TIMEOUT_MS) {
      studentEffectiveNow = new Date(Math.min(nowMs, lastSeenMs + HEARTBEAT_GRACE_CREDIT_MS));
      studentTimedOut = true;
    }
  }

  if (vs.overlapStartedAt) {
    const overlapStartMs = new Date(vs.overlapStartedAt).getTime();
    const overlapEndMs = Math.min(expertEffectiveNow.getTime(), studentEffectiveNow.getTime());
    const deltaOverlapSec = Math.max(0, Math.floor((overlapEndMs - overlapStartMs) / 1000));
    vs.bothConnectedSeconds = (vs.bothConnectedSeconds || 0) + deltaOverlapSec;

    if (expertTimedOut || studentTimedOut || !vs.expertLastJoinedAt || !vs.studentLastJoinedAt) {
      vs.overlapStartedAt = null;
    } else {
      vs.overlapStartedAt = now;
    }
  }

  if (vs.expertLastJoinedAt) {
    const rawJoinMs = new Date(vs.expertLastJoinedAt).getTime();
    const effectiveStartMs = scheduledStartMs > 0 ? Math.max(rawJoinMs, scheduledStartMs) : rawJoinMs;
    const deltaSec = Math.max(0, Math.floor((expertEffectiveNow.getTime() - effectiveStartMs) / 1000));
    vs.expertPresentSeconds = (vs.expertPresentSeconds || 0) + deltaSec;
    if (expertTimedOut) {
      vs.expertLastJoinedAt = null;
      vs.expertLeftAt = expertEffectiveNow;
    } else {
      vs.expertLastJoinedAt = now;
    }
  }

  if (vs.studentLastJoinedAt) {
    const rawJoinMs = new Date(vs.studentLastJoinedAt).getTime();
    const effectiveStartMs = scheduledStartMs > 0 ? Math.max(rawJoinMs, scheduledStartMs) : rawJoinMs;
    const deltaSec = Math.max(0, Math.floor((studentEffectiveNow.getTime() - effectiveStartMs) / 1000));
    vs.studentPresentSeconds = (vs.studentPresentSeconds || 0) + deltaSec;
    if (studentTimedOut) {
      vs.studentLastJoinedAt = null;
      vs.studentLeftAt = studentEffectiveNow;
    } else {
      vs.studentLastJoinedAt = now;
    }
  }

  vs.actualDurationMinutes = Math.floor((vs.bothConnectedSeconds || 0) / 60);

  if (!callRequest.zoomMeeting) callRequest.zoomMeeting = {};
  callRequest.zoomMeeting.durationSeconds = vs.bothConnectedSeconds || 0;
  callRequest.zoomMeeting.actualDurationMinutes = vs.actualDurationMinutes;
};

const recordParticipantJoin = async (callRequest, role, eventTime = new Date()) => {
  ensureBookingVideoSession(callRequest);
  const now = new Date(eventTime);
  const vs = callRequest.videoSession;

  flushAttendanceTimers(callRequest, now);

  if (role === 'expert') {
    if (!vs.expertJoinedAt) vs.expertJoinedAt = now;
    vs.expertLastJoinedAt = now;
    vs.expertLastSeenAt = now;
    callRequest.zoomMeeting.expertJoinedAt = vs.expertJoinedAt;
  } else if (role === 'student') {
    if (!vs.studentJoinedAt) vs.studentJoinedAt = now;
    vs.studentLastJoinedAt = now;
    vs.studentLastSeenAt = now;
    callRequest.zoomMeeting.studentJoinedAt = vs.studentJoinedAt;
    callRequest.zoomMeeting.lastParticipantJoinTime = now;
  }

  if (vs.expertLastJoinedAt && vs.studentLastJoinedAt && !vs.overlapStartedAt) {
    vs.overlapStartedAt = now;
  }

  if (vs.status === 'waiting') vs.status = 'in_progress';
  if (callRequest.zoomMeeting.status === 'waiting') callRequest.zoomMeeting.status = 'in_progress';

  callRequest.markModified('videoSession');
  callRequest.markModified('zoomMeeting');
  await callRequest.save();
  return callRequest;
};

const recordParticipantLeave = async (callRequest, role, eventTime = new Date()) => {
  ensureBookingVideoSession(callRequest);
  const now = new Date(eventTime);
  const vs = callRequest.videoSession;

  if (role === 'expert') vs.expertLastSeenAt = now;
  else if (role === 'student') vs.studentLastSeenAt = now;

  flushAttendanceTimers(callRequest, now);

  if (role === 'expert') {
    vs.expertLastJoinedAt = null;
    vs.expertLeftAt = now;
  } else if (role === 'student') {
    vs.studentLastJoinedAt = null;
    vs.studentLeftAt = now;
    callRequest.zoomMeeting.lastParticipantJoinTime = null;
  }

  vs.overlapStartedAt = null;
  await evaluateSessionState(callRequest, { isFinalCheck: false, referenceTime: now });

  callRequest.markModified('videoSession');
  callRequest.markModified('zoomMeeting');
  await callRequest.save();
  return callRequest;
};

const evaluateSessionState = async (
  callRequest,
  { isFinalCheck = false, referenceTime = new Date() } = {}
) => {
  ensureBookingVideoSession(callRequest);
  const now = new Date(referenceTime);
  const nowMs = now.getTime();
  const vs = callRequest.videoSession;

  if (['completed', 'expert_no_show', 'student_no_show'].includes(vs.status)) {
    return callRequest;
  }

  flushAttendanceTimers(callRequest, now);

  const scheduledStartMs = callRequest.scheduledAt ? new Date(callRequest.scheduledAt).getTime() : 0;
  const durationMins = Number(callRequest.durationMinutes) || 30;
  const durationSec = durationMins * 60;
  const scheduledEndMs = callRequest.scheduledEndAt
    ? new Date(callRequest.scheduledEndAt).getTime()
    : scheduledStartMs + durationSec * 1000;

  const requiredOverlapSec = Math.round(durationSec * 0.7);
  const actualOverlapSec = vs.bothConnectedSeconds || 0;

  if (vs.expertJoinedAt && vs.studentJoinedAt && actualOverlapSec >= requiredOverlapSec) {
    callRequest.status = 'completed';
    if (callRequest.paymentStatus === 'paid') callRequest.paymentStatus = 'payout_ready';
    vs.status = 'completed';
    vs.completionReason = 'both_attended_70_percent_plus';
    vs.endedAt = vs.endedAt || now;
    callRequest.zoomMeeting.status = 'completed';
    return callRequest;
  }

  if (!isFinalCheck && nowMs < scheduledEndMs) return callRequest;

  const bothActivelyInRoom = Boolean(vs.expertLastJoinedAt && vs.studentLastJoinedAt);
  if (bothActivelyInRoom && nowMs < scheduledEndMs + 15 * 60 * 1000) return callRequest;

  const maxExpertLateArrivalMs = (durationMins <= 10 ? 5 : 10) * 60 * 1000;
  const requiredExpertWaitSec = durationMins <= 10 ? 420 : 600;

  const expertJoinedOnTime =
    vs.expertJoinedAt && new Date(vs.expertJoinedAt).getTime() <= scheduledStartMs + maxExpertLateArrivalMs;
  const expertMetWaitRequirement = (vs.expertPresentSeconds || 0) >= requiredExpertWaitSec;
  const studentPresentSec = vs.studentPresentSeconds || 0;
  const studentWasAbsentOrDitched =
    !vs.studentJoinedAt ||
    studentPresentSec < requiredOverlapSec ||
    new Date(vs.studentJoinedAt).getTime() > scheduledStartMs + maxExpertLateArrivalMs;

  if (expertJoinedOnTime && expertMetWaitRequirement && studentWasAbsentOrDitched) {
    callRequest.status = 'completed';
    if (callRequest.paymentStatus === 'paid') callRequest.paymentStatus = 'payout_ready';
    vs.status = 'student_no_show';
    vs.completionReason = !vs.studentJoinedAt ? 'student_no_show_expert_waited' : 'student_late_or_left_early';
    vs.endedAt = now;
    callRequest.zoomMeeting.status = 'student_no_show';
    return callRequest;
  }

  callRequest.status = 'completed';
  if (callRequest.paymentStatus === 'paid') callRequest.paymentStatus = 'failed';
  vs.status = 'expert_no_show';
  vs.completionReason = !vs.expertJoinedAt ? 'expert_never_joined' : 'insufficient_overlap';
  vs.endedAt = now;
  callRequest.zoomMeeting.status = 'expert_no_show';

  return callRequest;
};

// ============================================================================
// EXPORTED CONTROLLER METHODS (Mapped to livekitRoutes.js)[cite: 6]
// ============================================================================

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

    if (!isRequester && !isRecipient) {
      return res.status(403).json({ success: false, error: 'Security Alert: Unauthorized participant.' });
    }

    if (['cancelled', 'rejected'].includes(callRequest.status)) {
      return res.status(400).json({ success: false, error: `Appointment has been ${callRequest.status}.` });
    }

    if (!['paid', 'payout_ready', 'payout_processing'].includes(callRequest.paymentStatus)) {
      return res.status(402).json({ success: false, error: 'Payment must be completed before joining.' });
    }

    const nowMs = Date.now();
    const scheduledStartMs = new Date(callRequest.scheduledAt).getTime();
    const durationMinutes = Number(callRequest.durationMinutes) || 30;
    const scheduledEndMs = scheduledStartMs + durationMinutes * 60 * 1000;

    const earliestJoinMs = scheduledStartMs - 5 * 60 * 1000;
    const latestJoinMs = scheduledEndMs + 30 * 60 * 1000;

    if (nowMs < earliestJoinMs) {
      const minsUntilUnlock = Math.ceil((earliestJoinMs - nowMs) / 60000);
      return res.status(400).json({
        success: false,
        error: `Video room unlocks 5 minutes before session (in ~${minsUntilUnlock} min).`,
      });
    }

    if (nowMs > latestJoinMs) {
      return res.status(400).json({ success: false, error: 'The scheduled window for this session has ended.' });
    }

    const [expertProfile, studentProfile] = await Promise.all([
      Profile.findOne({ user: callRequest.recipient._id }).select('designation companyName profileImage').lean(),
      Profile.findOne({ user: callRequest.requester._id }).select('major university profileImage').lean(),
    ]);

    const { roomName } = ensureBookingVideoSession(callRequest);
    const participantRole = isRecipient ? 'expert' : 'student';
    const participantIdentity = `${participantRole}_${userIdStr}`;
    const participantName = isRecipient ? callRequest.recipient.name : callRequest.requester.name;

    await recordParticipantJoin(callRequest, participantRole, new Date());

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
          bothConnectedSeconds: callRequest.videoSession?.bothConnectedSeconds || 0,
          expertPresentSeconds: callRequest.videoSession?.expertPresentSeconds || 0,
          studentPresentSeconds: callRequest.videoSession?.studentPresentSeconds || 0,
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

exports.reportSessionEvent = async (req, res, next) => {
  try {
    const { requestId, action } = req.body;
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
        bothConnectedSeconds: callRequest.videoSession?.bothConnectedSeconds || 0,
        expertPresentSeconds: callRequest.videoSession?.expertPresentSeconds || 0,
        studentPresentSeconds: callRequest.videoSession?.studentPresentSeconds || 0,
        videoSession: callRequest.videoSession,
      },
    });
  } catch (error) {
    next(error);
  }
};

exports.livekitWebhook = async (req, res) => {
  try {
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    const rawBody = req.rawBody || JSON.stringify(req.body);

    let event;
    try {
      event = await verifyLiveKitWebhook(rawBody, authHeader);
    } catch (verifyErr) {
      return res.status(401).send('Invalid LiveKit webhook signature');
    }

    const eventType = event.event;
    const eventId = event.id;
    const roomName = event.room?.name;

    if (!roomName || !roomName.startsWith('yb_session_')) {
      return res.status(200).send('Ignored non-YB room');
    }

    const callRequest = await CallRequest.findOne({
      $or: [{ 'videoSession.roomName': roomName }, { 'zoomMeeting.meetingId': roomName }],
    });

    if (!callRequest) return res.status(200).send('Session record not found');

    ensureBookingVideoSession(callRequest);

    if (eventId && callRequest.videoSession.processedWebhookIds?.includes(eventId)) {
      return res.status(200).send('Duplicate webhook ignored');
    }
    if (eventId) callRequest.videoSession.processedWebhookIds.push(eventId);

    const identity = event.participant?.identity || '';
    const role = identity.startsWith('expert_') ? 'expert' : identity.startsWith('student_') ? 'student' : null;
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