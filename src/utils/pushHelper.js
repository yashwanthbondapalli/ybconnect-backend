// backend/src/utils/pushHelper.js
const axios = require('axios');
const mongoose = require('mongoose');
const User = require('../models/User');

async function sendPushNotification(userId, title, body, customData = {}) {
  try {
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) return;

    const user = await User.findById(userId)
      .select('name expoPushToken isDeleted accountStatus')
      .lean();

    if (
      !user ||
      user.isDeleted ||
      user.accountStatus === 'suspended' ||
      typeof user.expoPushToken !== 'string' ||
      !user.expoPushToken.startsWith('ExponentPushToken')
    ) {
      return;
    }

    await axios.post(
      'https://exp.host/--/api/v2/push/send',
      {
        to: user.expoPushToken,
        sound: 'default',
        title: String(title || 'YB Connect').slice(0, 100),
        body: String(body || '').slice(0, 300),
        data: { screen: 'AppointmentsScreen', ...customData },
      },
      { timeout: 8000 }
    );
  } catch (error) {
    console.error('❌ Push Notification Error:', error.message);
  }
}

module.exports = sendPushNotification;