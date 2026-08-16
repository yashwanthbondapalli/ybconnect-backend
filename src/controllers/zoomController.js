const axios = require('axios');
const Profile = require('../models/Profile');
const jwt = require('jsonwebtoken'); 
const crypto = require('crypto');
const { encrypt } = require('../utils/encryption');
const CallRequest = require('../models/CallRequest');


const REDIRECT_URI = process.env.ZOOM_REDIRECT_URI;

// 1. GENERATE THE LOGIN URL
exports.connectZoom = async (req, res) => {
  try {
    const userId = req.user._id.toString();
    const jwtState = jwt.sign({ userId: req.user._id }, process.env.JWT_SECRET, { expiresIn: '15m' });
    
    const safeRedirectUri = encodeURIComponent(process.env.ZOOM_REDIRECT_URI);
    
    const zoomAuthUrl = `https://zoom.us/oauth/authorize?response_type=code&client_id=${process.env.ZOOM_CLIENT_ID}&redirect_uri=${safeRedirectUri}&state=${jwtState}`;
    
    return res.status(200).json({ 
      success: true, 
      url: zoomAuthUrl 
    });

  } catch (error) {
    console.error("💥 ZOOM AUTH GENERATION CRASHED:", error.message);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to generate Zoom connection link.' 
    });
  }
};

// 2. THE SECRET CALLBACK (HANDSHAKE)
exports.zoomCallback = async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.status(400).send('No authorization code provided from Zoom.');
  if (!state) return res.status(400).send('No state (User ID) provided from Zoom.');

  try {
    const authHeader = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');

    const response = await axios.post('https://zoom.us/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
      },
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const decoded = jwt.verify(state, process.env.JWT_SECRET); 
    const verifiedUserId = decoded.userId;

    const { access_token, refresh_token } = response.data;
    
    const expertProfile = await Profile.findOneAndUpdate(
      { user: verifiedUserId }, 
      { 
        $set: {
  'zoomCredentials.accessToken': encrypt(access_token),
  'zoomCredentials.refreshToken': encrypt(refresh_token),
  'zoomCredentials.isConnected': true
}
      },
      { new: true, upsert: true } 
    );

    if (!expertProfile) return res.status(404).send('Profile not found.');

// 🚨 PREMIUM UI UPGRADE: Beautiful Success Card Response
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Connection Successful</title>
        <style>
          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          }
          body {
            background-color: #090A0F;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 20px;
            overflow: hidden;
          }
          /* Ambient glowing backgrounds behind the card */
          body::before {
            content: '';
            position: absolute;
            width: 300px;
            height: 300px;
            background: rgba(168, 85, 247, 0.15);
            border-radius: 50%;
            filter: blur(80px);
            top: 20%;
            left: 20%;
            z-index: 1;
          }
          body::after {
            content: '';
            position: absolute;
            width: 300px;
            height: 300px;
            background: rgba(16, 185, 129, 0.15);
            border-radius: 50%;
            filter: blur(80px);
            bottom: 20%;
            right: 20%;
            z-index: 1;
          }
          .card {
            background: rgba(17, 22, 36, 0.7);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 24px;
            padding: 40px 30px;
            width: 100%;
            max-width: 420px;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
            z-index: 2;
            animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1);
          }
          .icon-container {
            width: 80px;
            height: 80px;
            background: rgba(16, 185, 129, 0.1);
            border: 2px solid rgba(16, 185, 129, 0.4);
            border-radius: 50%;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 auto 28px;
            position: relative;
            box-shadow: 0 0 20px rgba(16, 185, 129, 0.2);
            animation: pulse 2s infinite;
          }
          .icon-check {
            color: #10B981;
            font-size: 38px;
            font-weight: bold;
          }
          h1 {
            color: #FFFFFF;
            font-size: 24px;
            font-weight: 800;
            margin-bottom: 12px;
            letter-spacing: -0.5px;
          }
          p {
            color: #94A3B8;
            font-size: 15px;
            line-height: 1.6;
            margin-bottom: 28px;
          }
          .badge-container {
            display: flex;
            justify-content: center;
            gap: 12px;
            align-items: center;
            margin-bottom: 32px;
            background: rgba(255, 255, 255, 0.03);
            padding: 10px 16px;
            border-radius: 14px;
            border: 1px solid rgba(255, 255, 255, 0.05);
          }
          .badge-text {
            color: #E2E8F0;
            font-size: 13px;
            font-weight: 600;
          }
          .divider {
            color: #475569;
            font-size: 12px;
          }
          .close-btn {
            background: #10B981;
            color: #FFFFFF;
            border: none;
            padding: 14px 28px;
            border-radius: 14px;
            font-size: 15px;
            font-weight: 700;
            width: 100%;
            cursor: pointer;
            transition: all 0.2s ease;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
          }
          .close-btn:hover {
            background: #059669;
            transform: translateY(-1px);
            box-shadow: 0 6px 20px rgba(16, 185, 129, 0.4);
          }
          .close-btn:active {
            transform: translateY(0);
          }
          @keyframes slideUp {
            from { transform: translateY(30px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          @keyframes pulse {
            0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
            70% { box-shadow: 0 0 0 16px rgba(16, 185, 129, 0); }
            100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="icon-container">
            <span class="icon-check">✓</span>
          </div>
          <h1>Hurray! Connected</h1>
          <p>Your Zoom account has been successfully linked to your profile. You are now ready to host live premium mentorship sessions. You can close the window</p>
          
          <div class="badge-container">
            <span class="badge-text" style="color: #f6f3f9;">YB Connect</span>
            <span class="divider">✕</span>
            <span class="badge-text" style="color: #2D8CFF;">Zoom</span>
          </div>
        </div>

       
      </body>
      </html>
    `);

  } catch (error) {
    console.error('Zoom Callback Error:', error.response?.data || error);
    res.status(500).send('Authentication failed. Please try again.');
  }
};

// 3. THE AUTOMATED WEBHOOK (Zoom talks to us!)
exports.zoomWebhook = async (req, res) => {
  try {
    const webhookEvent = req.body.event;
    const payload = req.body.payload;
    console.log(`\n🚨 ZOOM WEBHOOK RECEIVED: ${webhookEvent}`);

    // 1. THE ZOOM SECURITY CHALLENGE
    if (webhookEvent === 'endpoint.url_validation') {
      const hashForValidate = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET)
        .update(payload.plainToken)
        .digest('hex');

      return res.status(200).json({
        plainToken: payload.plainToken,
        encryptedToken: hashForValidate
      });
    }

    // 2. VERIFY EVERY INCOMING PING IS ACTUALLY FROM ZOOM
    const zoomSignature = req.headers['x-zm-signature'];
    const zoomTimestamp = req.headers['x-zm-request-timestamp'];
    const message = `v0:${zoomTimestamp}:${req.rawBody}`; 
    const hashForVerify = crypto.createHmac('sha256', process.env.ZOOM_WEBHOOK_SECRET).update(message).digest('hex');
    const signature = `v0=${hashForVerify}`;

    if (signature !== zoomSignature) {
      return res.status(401).send('Invalid Webhook Signature. Hacker blocked.');
    }

    // 3. FIND THE MEETING
    const zoomMeetingId = payload.object.id.toString();
    const callRequest = await CallRequest.findOne({ 'zoomMeeting.meetingId': zoomMeetingId });

    if (!callRequest) {
      return res.status(200).send('Request not found, but webhook received.');
    }

    // 🚨 THE ZOMBIE GUARD
    if (callRequest.status === 'completed' || callRequest.status === 'rejected') {
      console.log(`🛡️ Zombie Guard Active: Ignored late webhook for finalized meeting ${zoomMeetingId}.`);
      return res.status(200).send('Meeting finalized. Ignoring webhook.');
    }

    // ==========================================
    // EVENT A: MEETING STARTED (Expert Arrives)
    // ==========================================
    if (webhookEvent === 'meeting.started') {
      callRequest.zoomMeeting.status = 'in_progress';
      
      // Only log the FIRST time they join
      if (!callRequest.zoomMeeting.expertJoinedAt) {
        callRequest.zoomMeeting.expertJoinedAt = new Date(payload.object.start_time || Date.now());
      }
      
      callRequest.markModified('zoomMeeting'); 
      await callRequest.save();
      console.log(`🛡️ Expert has entered meeting ${zoomMeetingId}`);
      return res.status(200).send('Meeting started processed');
    }

    // ==========================================
    // EVENT B: PARTICIPANT JOINED (Student Arrives)
    // ==========================================
    if (webhookEvent === 'meeting.participant_joined') {
      const participant = payload.object.participant;
      const hostId = payload.object.host_id;

      // SHIELD: Ignore if the person joining is the Host/Expert
      if (participant.id === hostId || participant.role === 'host') {
          console.log('🛡️ Host joined, ignoring ghost student trigger.');
          return res.status(200).send('Ignored Host Join');
      }

      // If it passes the shield, it is actually the student!
      callRequest.zoomMeeting.studentJoinedAt = callRequest.zoomMeeting.studentJoinedAt || new Date();
      callRequest.zoomMeeting.lastParticipantJoinTime = new Date(); // Start the real stopwatch now!
      
      callRequest.markModified('zoomMeeting');
      await callRequest.save();
      console.log(`🛡️ Student has officially entered meeting ${zoomMeetingId}`);
      return res.status(200).send('Student joined processed');
    }

    // ==========================================
    // 🚨 EVENT C: THE MEETING ENDED (The Time Gate)
    // ==========================================
    if (webhookEvent === 'meeting.ended') {
      let chunkDurationMinutes = 0;

      // ACCUMULATOR: Only add time if the student actually joined during this chunk!
      if (callRequest.zoomMeeting.lastParticipantJoinTime) {
        const actualEndTime = new Date(payload.object.end_time || Date.now());
        const actualStartTime = new Date(callRequest.zoomMeeting.lastParticipantJoinTime);
        
        if (actualEndTime > actualStartTime) {
            chunkDurationMinutes = Math.ceil((actualEndTime - actualStartTime) / (1000 * 60)); 
        }
      } else {
         console.log(`⚠️ Meeting ended, but Student never joined this chunk. 0 minutes added.`);
      }

      // Add this valid student time to the total
      const previousDuration = callRequest.zoomMeeting.actualDurationMinutes || 0;
      const newTotalDuration = previousDuration + chunkDurationMinutes;
      callRequest.zoomMeeting.actualDurationMinutes = newTotalDuration;

      console.log(`Meeting Chunk Ended: +${chunkDurationMinutes} mins. Total Student Time: ${newTotalDuration} mins.`);

      // Reset the join timer for the next chunk so we don't double count
      callRequest.zoomMeeting.lastParticipantJoinTime = null; 

      // TIME GATE CHECK: Is it an "Early Bird" accident?
      const scheduledTime = new Date(callRequest.scheduledAt).getTime();
      const currentTime = Date.now();

      if (currentTime < scheduledTime) {
        console.log(`⚠️ EARLY BIRD DETECTED: Call ended before scheduled time. Leaving door open.`);
        callRequest.zoomMeeting.status = 'waiting'; 
        callRequest.markModified('zoomMeeting');
        await callRequest.save();
        return res.status(200).send('Processed as Early Bird accident');
      }

      // If we reach here, it's the actual scheduled session window.
      // Did the student ever show up at all?
      if (!callRequest.zoomMeeting.studentJoinedAt) {
        console.log(`🚨 FRAUD WARNING: Student never joined. Keeping session open for reconnect.`);
        callRequest.markModified('zoomMeeting');
        await callRequest.save();
        return res.status(200).send('Student missing. Waiting for reconnect.');
      }

      // If Student total time is > 3 minutes, the session is officially a success!
      if (newTotalDuration >= 3) {
         callRequest.status = 'completed';             // 👈 NEW: Tells the app to move this to the Completed Tab
         callRequest.paymentStatus = 'payout_ready';   // Secures the money
         callRequest.zoomMeeting.status = 'completed';
         console.log(`✅ Session success! Escrow released to Expert.`);
      } else {
         console.log(`⏳ Session too short (${newTotalDuration} mins). Waiting to see if they reconnect.`);
      }
      
      callRequest.markModified('zoomMeeting');
      await callRequest.save();
      return res.status(200).send('Meeting ended processed');
    }

    res.status(200).send('Webhook unhandled but received');

  } catch (error) {
    console.error('Zoom Webhook Error:', error);
    res.status(500).send('Webhook failed');
  }
};


// 4. MANUAL DISCONNECT (Security Review Requirement)
exports.disconnectZoom = async (req, res) => {
  try {
    const userId = req.user._id.toString();

    // Find the profile and wipe the Zoom credentials
    const expertProfile = await Profile.findOneAndUpdate(
      { user: userId },
      { 
        $set: {
          'zoomCredentials.accessToken': null,
          'zoomCredentials.refreshToken': null,
          'zoomCredentials.isConnected': false
        }
      },
      { new: true }
    );

    if (!expertProfile) {
      return res.status(404).json({ success: false, error: 'Profile not found.' });
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Zoom disconnected successfully.' 
    });

  } catch (error) {
    console.error("💥 ZOOM DISCONNECT CRASHED:", error.message);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to disconnect Zoom account.' 
    });
  }
};