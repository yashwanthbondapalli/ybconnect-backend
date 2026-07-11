const axios = require('axios');
const Profile = require('../models/Profile'); // Adjust path to your Profile model

/**
 * 1. THE TOKEN REFRESHER
 * Silently gets a fresh 60-minute access token using the permanent refresh token.
 */
const refreshZoomToken = async (expertProfile) => {
  try {
    const authHeader = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');

    const response = await axios.post('https://zoom.us/oauth/token', null, {
      params: {
        grant_type: 'refresh_token',
        refresh_token: expertProfile.zoomCredentials.refreshToken,
      },
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const { access_token, refresh_token } = response.data;

    // Save the fresh tokens back to the database
    expertProfile.zoomCredentials.accessToken = access_token;
    expertProfile.zoomCredentials.refreshToken = refresh_token; // Zoom gives us a new refresh token every time too!
    // 🚨 FIX 1: FORCE MONGOOSE TO SAVE THE NESTED OBJECT
    expertProfile.markModified('zoomCredentials');
   await Profile.updateOne(
  { _id: expertProfile._id },
  { 
    $set: { 
      'zoomCredentials.accessToken': access_token,
      'zoomCredentials.refreshToken': refresh_token
    } 
  }
);

    return access_token;
  } catch (error) {
    console.error('Error refreshing Zoom token:', error.response?.data || error.message);
    // 🚨 ENTERPRISE SECURITY FIX: If Zoom rejects the refresh token, sever the connection in DB.
    if (error.response && (error.response.status === 400 || error.response.status === 401)) {
       await Profile.updateOne(
         { _id: expertProfile._id },
         { $set: { 'zoomCredentials.isConnected': false } }
       );
       throw new Error('Your Zoom session expired or was disconnected. Please reconnect your Zoom account.');
    }

    throw new Error('Could not refresh Zoom token due to a network error.');
  }
};

/**
 * 2. THE MEETING GENERATOR
 * Called exactly when an appointment is confirmed/paid.
 */
exports.createZoomMeeting = async (expertUserId, topic, startTime, durationMinutes) => {
  try {
    // 1. Find the Expert's profile using their User ID
    const expertProfile = await Profile.findOne({ user: expertUserId });

    if (!expertProfile || !expertProfile.zoomCredentials?.isConnected) {
      throw new Error('Expert has not connected their Zoom account.');
    }

    // 2. ALWAYS refresh the token first to avoid the 1-Hour Trap
    const freshAccessToken = await refreshZoomToken(expertProfile);

    // 3. Tell Zoom to create the meeting
    const response = await axios.post(
      'https://api.zoom.us/v2/users/me/meetings',
      {
        topic: topic || 'BacktoBase Consultation',
        type: 2, // Type 2 means a Scheduled Meeting
        start_time: startTime, // Must be in ISO 8601 format (e.g., "2026-04-10T10:00:00Z")
        duration: durationMinutes,
        settings: {
          host_video: true,
          participant_video: true,
          join_before_host: false,
          waiting_room: true, // CRITICAL: Prevents link-sharing fraud
          mute_upon_entry: true,
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${freshAccessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    // 4. Return the golden URLs and Meeting ID!
    return {
      meetingId: response.data.id,
      startUrl: response.data.start_url, // Private link for the EXPERT ONLY
      joinUrl: response.data.join_url,   // Public link for the STUDENT
    };

  } catch (error) {
    console.error('Error creating Zoom meeting:', error.response?.data || error.message);
    throw error;
  }
};