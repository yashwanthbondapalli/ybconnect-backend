// backend/src/utils/livekitHelper.js
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

let livekitSdk = null;
try {
  livekitSdk = require('livekit-server-sdk');
} catch (e) {
  // Fallback to RFC-compliant JWT signing if SDK is ESM-only
}

// If a client stops sending 20s heartbeats for >65s (e.g. app killed / battery dead),
// cap their active time chunk at lastSeenAt + 20s so nobody can fake attendance.
const HEARTBEAT_TIMEOUT_MS = 65 * 1000;
const HEARTBEAT_GRACE_CREDIT_MS = 20 * 1000;

/**
 * Returns the deterministic, private LiveKit room name for a booking
 */
const getRoomNameForRequest = (requestId) => {
  return `yb_session_${String(requestId).trim()}`;
};

/**
 * Ensures the booking has its LiveKit room metadata initialized
 */
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

/**
 * Generates a short-lived, room-scoped LiveKit Access Token
 */
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
    throw new Error(
      'LiveKit server credentials (LIVEKIT_API_KEY / LIVEKIT_API_SECRET) are missing in .env'
    );
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

/**
 * Verifies an incoming LiveKit Webhook request signature and returns the parsed event
 */
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

/**
 * Flushes active attendance timers up to `referenceTime`.
 * Protects against force-closed apps / dead batteries via HEARTBEAT_TIMEOUT_MS.
 * Strictly counts `bothConnectedSeconds` ONLY when both participants are in the room simultaneously.
 */
const flushAttendanceTimers = (callRequest, referenceTime = new Date()) => {
  const now = new Date(referenceTime);
  const nowMs = now.getTime();
  const vs = callRequest.videoSession || {};

  // Check if Expert's heartbeat lease expired (force-closed app without /leave)
  let expertEffectiveNow = now;
  let expertTimedOut = false;
  if (vs.expertLastJoinedAt && vs.expertLastSeenAt) {
    const lastSeenMs = new Date(vs.expertLastSeenAt).getTime();
    if (nowMs - lastSeenMs > HEARTBEAT_TIMEOUT_MS) {
      expertEffectiveNow = new Date(Math.min(nowMs, lastSeenMs + HEARTBEAT_GRACE_CREDIT_MS));
      expertTimedOut = true;
    }
  }

  // Check if Student's heartbeat lease expired
  let studentEffectiveNow = now;
  let studentTimedOut = false;
  if (vs.studentLastJoinedAt && vs.studentLastSeenAt) {
    const lastSeenMs = new Date(vs.studentLastSeenAt).getTime();
    if (nowMs - lastSeenMs > HEARTBEAT_TIMEOUT_MS) {
      studentEffectiveNow = new Date(Math.min(nowMs, lastSeenMs + HEARTBEAT_GRACE_CREDIT_MS));
      studentTimedOut = true;
    }
  }

  // 1. Flush simultaneous overlap chunk FIRST (bounded by the earliest disconnect of either party)
  if (vs.overlapStartedAt) {
    const overlapStartMs = new Date(vs.overlapStartedAt).getTime();
    const overlapEndMs = Math.min(
      expertEffectiveNow.getTime(),
      studentEffectiveNow.getTime()
    );
    const deltaOverlapSec = Math.max(0, Math.floor((overlapEndMs - overlapStartMs) / 1000));
    vs.bothConnectedSeconds = (vs.bothConnectedSeconds || 0) + deltaOverlapSec;

    if (expertTimedOut || studentTimedOut || !vs.expertLastJoinedAt || !vs.studentLastJoinedAt) {
      vs.overlapStartedAt = null;
    } else {
      vs.overlapStartedAt = now;
    }
  }

  // 2. Flush Expert active chunk
  if (vs.expertLastJoinedAt) {
    const joinMs = new Date(vs.expertLastJoinedAt).getTime();
    const deltaSec = Math.max(0, Math.floor((expertEffectiveNow.getTime() - joinMs) / 1000));
    vs.expertPresentSeconds = (vs.expertPresentSeconds || 0) + deltaSec;
    if (expertTimedOut) {
      vs.expertLastJoinedAt = null;
      vs.expertLeftAt = expertEffectiveNow;
    } else {
      vs.expertLastJoinedAt = now;
    }
  }

  // 3. Flush Student active chunk
  if (vs.studentLastJoinedAt) {
    const joinMs = new Date(vs.studentLastJoinedAt).getTime();
    const deltaSec = Math.max(0, Math.floor((studentEffectiveNow.getTime() - joinMs) / 1000));
    vs.studentPresentSeconds = (vs.studentPresentSeconds || 0) + deltaSec;
    if (studentTimedOut) {
      vs.studentLastJoinedAt = null;
      vs.studentLeftAt = studentEffectiveNow;
    } else {
      vs.studentLastJoinedAt = now;
    }
  }

  // Actual duration is strictly the simultaneous talk time (in minutes)
  vs.actualDurationMinutes = Math.floor((vs.bothConnectedSeconds || 0) / 60);

  if (!callRequest.zoomMeeting) callRequest.zoomMeeting = {};
  callRequest.zoomMeeting.durationSeconds = vs.bothConnectedSeconds || 0;
  callRequest.zoomMeeting.actualDurationMinutes = vs.actualDurationMinutes;
};

/**
 * Records when an expert or student joins the LiveKit room
 */
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

  // Start simultaneous overlap stopwatch ONLY when BOTH are currently connected
  if (vs.expertLastJoinedAt && vs.studentLastJoinedAt && !vs.overlapStartedAt) {
    vs.overlapStartedAt = now;
  }

  if (vs.status === 'waiting') {
    vs.status = 'in_progress';
  }
  if (callRequest.zoomMeeting.status === 'waiting') {
    callRequest.zoomMeeting.status = 'in_progress';
  }

  callRequest.markModified('videoSession');
  callRequest.markModified('zoomMeeting');
  await callRequest.save();
  return callRequest;
};

/**
 * Records when an expert or student leaves / disconnects from the LiveKit room
 */
const recordParticipantLeave = async (callRequest, role, eventTime = new Date()) => {
  ensureBookingVideoSession(callRequest);
  const now = new Date(eventTime);
  const vs = callRequest.videoSession;

  if (role === 'expert') {
    vs.expertLastSeenAt = now;
  } else if (role === 'student') {
    vs.studentLastSeenAt = now;
  }

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

/**
 * Authoritative Fair-Play Session Lifecycle & Escrow Evaluator
 *
 * Rules Enforced:
 *  1. 70% Simultaneous Talk-Time Rule:
 *     - 10m call -> >= 7m (420s) simultaneous overlap
 *     - 20m call -> >= 14m (840s) simultaneous overlap
 *     - 30m call -> >= 21m (1260s) simultaneous overlap
 *     - 40m call -> >= 28m (1680s) simultaneous overlap
 *     - 60m call -> >= 42m (2520s) simultaneous overlap
 *  2. Punctuality & Wait-Rule Fault Attribution (when talk-time < 70%):
 *     - Expert must join within the first 10 mins of scheduledAt (5 mins for a 10m call)
 *       AND stay for at least 10 mins (7 mins for a 10m call) to claim a payout if the
 *       student never shows up, arrives at the last minute, or ditches early.
 *     - If the Expert joins late (e.g. 2 mins before the end) and talk-time is < 70%,
 *       it is ruled `expert_no_show` -> 100% Refund to Student!
 */
const evaluateSessionState = async (
  callRequest,
  { isFinalCheck = false, referenceTime = new Date() } = {}
) => {
  ensureBookingVideoSession(callRequest);
  const now = new Date(referenceTime);
  const nowMs = now.getTime();
  const vs = callRequest.videoSession;

  // Do not mutate already finalized sessions
  if (['completed', 'expert_no_show', 'student_no_show'].includes(vs.status)) {
    return callRequest;
  }

  flushAttendanceTimers(callRequest, now);

  const scheduledStartMs = callRequest.scheduledAt
    ? new Date(callRequest.scheduledAt).getTime()
    : 0;
  const durationMins = Number(callRequest.durationMinutes) || 30;
  const durationSec = durationMins * 60;
  const scheduledEndMs = callRequest.scheduledEndAt
    ? new Date(callRequest.scheduledEndAt).getTime()
    : scheduledStartMs + durationSec * 1000;

  // 1. Required Simultaneous Overlap = 70% of Booked Duration
  // (10m -> 420s, 20m -> 840s, 30m -> 1260s, 40m -> 1680s, 60m -> 2520s)
  const requiredOverlapSec = Math.round(durationSec * 0.7);
  const actualOverlapSec = vs.bothConnectedSeconds || 0;

  // CASE A: Both participants talked together for >= 70% of the booked session!
  if (vs.expertJoinedAt && vs.studentJoinedAt && actualOverlapSec >= requiredOverlapSec) {
    callRequest.status = 'completed';
    if (callRequest.paymentStatus === 'paid') {
      callRequest.paymentStatus = 'payout_ready';
    }
    vs.status = 'completed';
    vs.completionReason = 'both_attended_70_percent_plus';
    vs.endedAt = vs.endedAt || now;
    callRequest.zoomMeeting.status = 'completed';
    return callRequest;
  }

  // While the session window is still open (before scheduledEndAt), DO NOT penalize or close early!
  // This allows participants to reconnect after network drops or finish their call.
  if (!isFinalCheck && nowMs < scheduledEndMs) {
    // Early Bird Reset: If someone tested the room before scheduledStartMs and left
    if (
      nowMs < scheduledStartMs &&
      !vs.expertLastJoinedAt &&
      !vs.studentLastJoinedAt &&
      actualOverlapSec < 60
    ) {
      vs.status = 'waiting';
      callRequest.zoomMeeting.status = 'waiting';
    }
    return callRequest;
  }

  // Overtime Protection: If both are STILL actively connected inside the room right now
  // (within 15 minutes past scheduledEndMs), let them finish talking so they can hit 70%!
  const bothActivelyInRoom = Boolean(vs.expertLastJoinedAt && vs.studentLastJoinedAt);
  if (bothActivelyInRoom && nowMs < scheduledEndMs + 15 * 60 * 1000) {
    return callRequest;
  }

  // ============================================================================
  // FINAL ADJUDICATION (Runs after scheduledEndAt when call < 70% overlap)
  // ============================================================================
  // Punctuality threshold: Expert must arrive within first 10 mins (or first 5 mins for a 10m call)
  const maxExpertLateArrivalMs = (durationMins <= 10 ? 5 : 10) * 60 * 1000;
  // Minimum wait time: Expert must stay in the room at least 10 mins (or 7 mins for a 10m call)
  const requiredExpertWaitSec = durationMins <= 10 ? 420 : 600;

  const expertJoinedOnTime =
    vs.expertJoinedAt &&
    new Date(vs.expertJoinedAt).getTime() <= scheduledStartMs + maxExpertLateArrivalMs;

  const expertMetWaitRequirement = (vs.expertPresentSeconds || 0) >= requiredExpertWaitSec;

  // Check if Expert was punctual and waited faithfully, while Student was the one who
  // never joined, joined at the very end (e.g. 2 mins before end), or ditched early:
  const studentPresentSec = vs.studentPresentSeconds || 0;
  const studentWasAbsentOrDitched =
    !vs.studentJoinedAt ||
    studentPresentSec < requiredOverlapSec ||
    new Date(vs.studentJoinedAt).getTime() > scheduledStartMs + maxExpertLateArrivalMs;

  if (expertJoinedOnTime && expertMetWaitRequirement && studentWasAbsentOrDitched) {
    callRequest.status = 'completed';
    if (callRequest.paymentStatus === 'paid') {
      callRequest.paymentStatus = 'payout_ready';
    }
    // If student never joined at all, mark student_no_show (blocks fake review).
    // If student joined late / left early, mark student_no_show so expert is protected.
    vs.status = 'student_no_show';
    vs.completionReason = !vs.studentJoinedAt
      ? 'student_no_show_expert_waited'
      : 'student_late_or_left_early_expert_waited';
    vs.endedAt = now;
    callRequest.zoomMeeting.status = 'student_no_show';
    return callRequest;
  }

  // ALL OTHER CASES:
  // - Expert never joined
  // - Expert joined late (e.g. 2 mins before end) and couldn't complete 70% of the session
  // - Expert joined on time but left early (< 10 mins wait / < 70% talk time)
  // - Neither joined
  // -> 100% Refund to Student's Refund Wallet!
  callRequest.status = 'completed';
  if (callRequest.paymentStatus === 'paid') {
    callRequest.paymentStatus = 'failed';
  }
  vs.status = 'expert_no_show';
  vs.completionReason = !vs.expertJoinedAt
    ? 'expert_never_joined'
    : !expertJoinedOnTime
    ? 'expert_joined_too_late_insufficient_overlap'
    : 'expert_left_early_insufficient_overlap';
  vs.endedAt = now;
  callRequest.zoomMeeting.status = 'expert_no_show';

  return callRequest;
};

module.exports = {
  getRoomNameForRequest,
  ensureBookingVideoSession,
  createParticipantToken,
  verifyLiveKitWebhook,
  flushAttendanceTimers,
  recordParticipantJoin,
  recordParticipantLeave,
  evaluateSessionState,
};