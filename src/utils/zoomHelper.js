const axios = require('axios');
const Profile = require('../models/Profile');
const { encrypt, decrypt } = require('../utils/encryption');

/**
 * 1. THE TOKEN REFRESHER
 * Only runs when the current token is officially dead.
 */
const refreshZoomToken = async (expertProfile) => {
  try {
    const authHeader = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');

    // 🚨 FIX 1: Zoom strongly prefers URL-Encoded Body over Query Params for tokens!
    const params = new URLSearchParams();
    params.append('grant_type', 'refresh_token');
   params.append(
  'refresh_token',
  decrypt(expertProfile.zoomCredentials.refreshToken)
);

    const response = await axios.post('https://zoom.us/oauth/token', params, {
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const { access_token, refresh_token } = response.data;
    
    // 🚨 FIX 2: Fallback in case Zoom doesn't send a new refresh token (prevents wiping the DB)
const safeRefreshToken = refresh_token || decrypt(
  expertProfile.zoomCredentials.refreshToken
);

const encryptedAccessToken = encrypt(access_token);
const encryptedRefreshToken = encrypt(safeRefreshToken);

// Keep the in-memory object usable for the current request
expertProfile.zoomCredentials.accessToken = encryptedAccessToken;
expertProfile.zoomCredentials.refreshToken = encryptedRefreshToken;

await Profile.updateOne(
  { _id: expertProfile._id },
  {
    $set: {
      'zoomCredentials.accessToken': encryptedAccessToken,
      'zoomCredentials.refreshToken': encryptedRefreshToken
    }
  }
);


    return access_token;
  } catch (error) {
    console.error('Error refreshing Zoom token:', error.response?.data || error.message);
    
    // If Zoom completely rejects the refresh attempt, sever the connection safely.
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
 * Uses Lazy Refreshing to prevent Race Conditions & Token Destruction!
 */
exports.createZoomMeeting = async (expertUserId, topic, startTime, durationMinutes) => {
  const expertProfile = await Profile.findOne({ user: expertUserId });

  if (!expertProfile || !expertProfile.zoomCredentials?.isConnected) {
    throw new Error('Expert has not connected their Zoom account.');
  }

let currentToken = decrypt(
  expertProfile.zoomCredentials.accessToken
);

  // A helper function so we don't write the Zoom request twice
  const executeZoomRequest = (token) => {
    return axios.post(
      'https://api.zoom.us/v2/users/me/meetings',
      {
        topic: topic || 'BacktoBase Consultation',
        type: 2, 
        start_time: startTime, 
        duration: durationMinutes,
        settings: {
          host_video: true,
          participant_video: true,
          join_before_host: false,
          waiting_room: true, 
          mute_upon_entry: true,
        },
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  };

  try {
    // 🚀 ATTEMPT 1: Try creating the meeting immediately with the token we already have
    const response = await executeZoomRequest(currentToken);
    
    return {
      meetingId: response.data.id,
      startUrl: response.data.start_url, 
      joinUrl: response.data.join_url,   
    };

  } catch (error) {
    // If the error IS NOT a 401 Expired error, it's a real bug. Throw it.
    if (!error.response || error.response.status !== 401) {
      console.error('Error creating Zoom meeting:', error.response?.data || error.message);
      throw error;
    }

    // 🚀 ATTEMPT 2: The token was officially expired (401). Let's refresh it and try exactly once more!
    console.log("⚠️ Zoom Token Expired. Refreshing token gracefully...");
    const freshToken = await refreshZoomToken(expertProfile);
    
    const retryResponse = await executeZoomRequest(freshToken);

    return {
      meetingId: retryResponse.data.id,
      startUrl: retryResponse.data.start_url,
      joinUrl: retryResponse.data.join_url,
    };
  }
};