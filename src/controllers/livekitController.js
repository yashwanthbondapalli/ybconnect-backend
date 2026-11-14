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
const WEB_MEET_BASE_URL = process.env.WEB_APP_URL || 'https://ybconnect.in';

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

// Enforce maxParticipants: 2 at the LiveKit SFU server level when SDK is available
const enforceOneToOneRoomLimits = async (roomName, emptyTimeoutSec = 300) => {
  try {
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const wsUrl = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !wsUrl || !livekitSdk?.RoomServiceClient) return;

    const httpUrl = wsUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
    const roomService = new livekitSdk.RoomServiceClient(httpUrl, apiKey, apiSecret);
    await roomService.createRoom({
      name: roomName,
      maxParticipants: 2, // Strictly 1 Student + 1 Mentor
      emptyTimeout: emptyTimeoutSec,
    });
  } catch (err) {
    // Non-fatal: token identity lock + webhook guard still enforce 1:1
  }
};

const createParticipantToken = async ({
  roomName,
  participantIdentity,
  participantName,
  metadata = {},
  ttlSeconds = 45 * 60,
}) => {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    const err = new Error('LiveKit credentials are missing in .env');
    err.statusCode = 503;
    err.code = 'LIVEKIT_CONFIG_MISSING';
    throw err;
  }

  const safeTtl = Math.max(300, Math.min(Number(ttlSeconds) || 2700, 90 * 60));
  const metadataStr = typeof metadata === 'string' ? metadata : JSON.stringify(metadata);

  if (livekitSdk && livekitSdk.AccessToken) {
    const at = new livekitSdk.AccessToken(apiKey, apiSecret, {
      identity: participantIdentity,
      name: participantName,
      metadata: metadataStr,
      ttl: safeTtl,
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
    exp: nowSec + safeTtl,
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

  if (vs.status === 'waiting' || vs.status === 'server_capacity_hold') vs.status = 'in_progress';
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

  // Never penalize mentor or student if LiveKit reported a quota/capacity outage
  if (['completed', 'expert_no_show', 'student_no_show', 'server_capacity_hold'].includes(vs.status)) {
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

// Shared helper to build token + session payload for both Mobile & Laptop Web
const buildSessionAccessPayload = async (callRequest, userIdStr) => {
  const isRequester = callRequest.requester._id.toString() === userIdStr;
  const isRecipient = callRequest.recipient._id.toString() === userIdStr;

  if (!isRequester && !isRecipient) {
    const err = new Error('Security Alert: Unauthorized participant.');
    err.statusCode = 403;
    throw err;
  }

  if (['cancelled', 'rejected'].includes(callRequest.status)) {
    const err = new Error(`Appointment has been ${callRequest.status}.`);
    err.statusCode = 400;
    throw err;
  }

  if (!['paid', 'payout_ready', 'payout_processing'].includes(callRequest.paymentStatus)) {
    const err = new Error('Payment must be completed before joining.');
    err.statusCode = 402;
    throw err;
  }

  const nowMs = Date.now();
  const scheduledStartMs = new Date(callRequest.scheduledAt).getTime();
  const durationMinutes = Number(callRequest.durationMinutes) || 30;
  const scheduledEndMs = scheduledStartMs + durationMinutes * 60 * 1000;

  const earliestJoinMs = scheduledStartMs - 5 * 60 * 1000;
  const latestJoinMs = scheduledEndMs + 15 * 60 * 1000; // Strictly capped at +15m grace to save LiveKit minutes

  if (nowMs > latestJoinMs) {
    const err = new Error('The scheduled window for this session has ended.');
    err.statusCode = 400;
    throw err;
  }

  const [expertProfile, studentProfile] = await Promise.all([
    Profile.findOne({ user: callRequest.recipient._id }).select('designation companyName profileImage').lean(),
    Profile.findOne({ user: callRequest.requester._id }).select('major university profileImage').lean(),
  ]);

  const { roomName } = ensureBookingVideoSession(callRequest);
  const participantRole = isRecipient ? 'expert' : 'student';
  // Same identity across Mobile + Web guarantees LiveKit kicks any duplicate tab/shared link!
  const participantIdentity = `${participantRole}_${userIdStr}`;
  const participantName = isRecipient ? callRequest.recipient.name : callRequest.requester.name;

  const sessionInfo = {
    requestId: callRequest._id,
    topic: callRequest.topic,
    scheduledAt: callRequest.scheduledAt,
    scheduledEndAt: new Date(scheduledEndMs).toISOString(),
    hardCutoffAt: new Date(latestJoinMs).toISOString(),
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
  };

  if (nowMs < earliestJoinMs) {
    const minsUntilUnlock = Math.ceil((earliestJoinMs - nowMs) / 60000);
    return {
      locked: true,
      unlocksAt: new Date(earliestJoinMs).toISOString(),
      minsUntilUnlock,
      role: participantRole,
      participantName,
      session: sessionInfo,
    };
  }

  await enforceOneToOneRoomLimits(roomName, 300);
  await recordParticipantJoin(callRequest, participantRole, new Date());

  // Dynamically cap token TTL to remaining session time + 10 mins grace so users cannot burn extra hours
  const dynamicTtlSeconds = Math.max(300, Math.ceil((latestJoinMs - nowMs) / 1000));

  const token = await createParticipantToken({
    roomName,
    participantIdentity,
    participantName,
    ttlSeconds: dynamicTtlSeconds,
    metadata: {
      requestId: callRequest._id.toString(),
      userId: userIdStr,
      role: participantRole,
      name: participantName,
    },
  });

  return {
    locked: false,
    token,
    wsUrl: process.env.LIVEKIT_URL || '',
    roomName,
    role: participantRole,
    participantIdentity,
    participantName,
    ttlSeconds: dynamicTtlSeconds,
    session: sessionInfo,
  };
};

// ============================================================================
// EXPORTED CONTROLLER METHODS
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
    const payload = await buildSessionAccessPayload(callRequest, userIdStr);

    if (payload.locked) {
      return res.status(400).json({
        success: false,
        error: `Video room unlocks 5 minutes before session (in ~${payload.minsUntilUnlock} min).`,
      });
    }

    return res.status(200).json({
      success: true,
      data: payload,
    });
  } catch (error) {
    console.error('LiveKit Token Error:', error.message);
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'SESSION_ACCESS_ERROR',
        error: error.message,
      });
    }
    next(error);
  }
};

// Generates a personal, cryptographically signed 1:1 web link for Laptop Browser
exports.createWebCallLink = async (req, res, next) => {
  try {
    const { requestId } = req.body;
    if (!requestId) {
      return res.status(400).json({ success: false, error: 'Booking requestId is required.' });
    }

    const callRequest = await CallRequest.findById(requestId);
    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Appointment not found.' });
    }

    const userIdStr = req.user._id.toString();
    const isRequester = callRequest.requester.toString() === userIdStr;
    const isRecipient = callRequest.recipient.toString() === userIdStr;

    if (!isRequester && !isRecipient) {
      return res.status(403).json({ success: false, error: 'Unauthorized participant.' });
    }

    if (callRequest.status !== 'accepted') {
      return res.status(400).json({
        success: false,
        error: 'Only confirmed appointments have an active video link.',
      });
    }

    if (!['paid', 'payout_ready', 'payout_processing'].includes(callRequest.paymentStatus)) {
      return res.status(402).json({
        success: false,
        error: 'Payment must be completed before generating a meeting link.',
      });
    }

    const nowMs = Date.now();
    const scheduledStartMs = new Date(callRequest.scheduledAt).getTime();
    const durationMinutes = Number(callRequest.durationMinutes) || 30;
    const latestJoinMs = scheduledStartMs + (durationMinutes + 15) * 60 * 1000;

    if (nowMs > latestJoinMs) {
      return res.status(400).json({
        success: false,
        error: 'This session window has already ended.',
      });
    }

    const role = isRecipient ? 'expert' : 'student';
    const expiresInSeconds = Math.max(900, Math.ceil((latestJoinMs - nowMs) / 1000));

    const webTicket = jwt.sign(
      {
        purpose: 'yb_web_video_session',
        requestId: callRequest._id.toString(),
        userId: userIdStr,
        role,
      },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: expiresInSeconds }
    );

    const webUrl = `${WEB_MEET_BASE_URL}/meet?id=${callRequest._id.toString()}&ticket=${encodeURIComponent(
      webTicket
    )}`;

    return res.status(200).json({
      success: true,
      data: {
        webUrl,
        role,
        expiresAt: new Date(latestJoinMs).toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Authenticates the Next.js Laptop Browser room using the signed webTicket
exports.getWebCallToken = async (req, res, next) => {
  try {
    const { requestId, ticket } = req.body;
    if (!requestId || !ticket) {
      return res.status(400).json({
        success: false,
        error: 'Missing meeting ID or security ticket. Please copy the link again from the YB Connect app.',
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(ticket, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      return res.status(401).json({
        success: false,
        error: 'This meeting link has expired or is invalid. Please copy a fresh link from the YB Connect mobile app.',
      });
    }

    if (
      decoded.purpose !== 'yb_web_video_session' ||
      String(decoded.requestId) !== String(requestId) ||
      !decoded.userId
    ) {
      return res.status(403).json({
        success: false,
        error: 'Security Alert: Ticket does not match this session.',
      });
    }

    const callRequest = await CallRequest.findById(requestId)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Appointment not found.' });
    }

    const payload = await buildSessionAccessPayload(callRequest, String(decoded.userId));

    return res.status(200).json({
      success: true,
      data: payload,
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code || 'SESSION_ACCESS_ERROR',
        error: error.message,
      });
    }
    next(error);
  }
};

// Shared helper for processing attendance & quota events from both Mobile and Web
const handleSessionEventCore = async ({ requestId, userIdStr, action, errorReason }) => {
  const callRequest = await CallRequest.findById(requestId);
  if (!callRequest) {
    const err = new Error('Session not found.');
    err.statusCode = 404;
    throw err;
  }

  const isRequester = callRequest.requester.toString() === userIdStr;
  const isRecipient = callRequest.recipient.toString() === userIdStr;

  if (!isRequester && !isRecipient) {
    const err = new Error('Unauthorized');
    err.statusCode = 403;
    throw err;
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
  } else if (action === 'quota_error') {
    // Protect both student and mentor if LiveKit free plan / quota is reached
    ensureBookingVideoSession(callRequest);
    flushAttendanceTimers(callRequest, now);
    callRequest.videoSession.status = 'server_capacity_hold';
    callRequest.videoSession.completionReason = errorReason || 'livekit_quota_or_capacity_limit';
    callRequest.markModified('videoSession');
    await callRequest.save();
  }

  return callRequest;
};

exports.reportSessionEvent = async (req, res, next) => {
  try {
    const { requestId, action, errorReason } = req.body;
    if (!requestId || !action) {
      return res.status(400).json({ success: false, error: 'requestId and action are required.' });
    }

    const callRequest = await handleSessionEventCore({
      requestId,
      userIdStr: req.user._id.toString(),
      action,
      errorReason,
    });

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
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    next(error);
  }
};

exports.reportWebSessionEvent = async (req, res, next) => {
  try {
    const { requestId, ticket, action, errorReason } = req.body;
    if (!requestId || !ticket || !action) {
      return res.status(400).json({ success: false, error: 'requestId, ticket, and action are required.' });
    }

    let decoded;
    try {
      decoded = jwt.verify(ticket, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Invalid or expired web session ticket.' });
    }

    if (
      decoded.purpose !== 'yb_web_video_session' ||
      String(decoded.requestId) !== String(requestId)
    ) {
      return res.status(403).json({ success: false, error: 'Ticket mismatch.' });
    }

    const callRequest = await handleSessionEventCore({
      requestId,
      userIdStr: String(decoded.userId),
      action,
      errorReason,
    });

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
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
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
    const allowedExpertIdentity = `expert_${callRequest.recipient.toString()}`;
    const allowedStudentIdentity = `student_${callRequest.requester.toString()}`;

    // Security Guard: Kick any participant whose identity does not match the 1:1 student or mentor
    if (
      eventType === 'participant_joined' &&
      identity &&
      identity !== allowedExpertIdentity &&
      identity !== allowedStudentIdentity
    ) {
      try {
        const wsUrl = process.env.LIVEKIT_URL;
        if (wsUrl && livekitSdk?.RoomServiceClient) {
          const httpUrl = wsUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
          const roomService = new livekitSdk.RoomServiceClient(
            httpUrl,
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET
          );
          await roomService.removeParticipant(roomName, identity);
        }
      } catch (kickErr) {}
      return res.status(200).send('Unauthorized participant removed');
    }

    const role =
      identity === allowedExpertIdentity
        ? 'expert'
        : identity === allowedStudentIdentity
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