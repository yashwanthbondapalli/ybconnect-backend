const axios = require('axios');
const User = require('../models/User');

/**
 * Sends an Expo Push Notification to a specific user
 * @param {string} userId - The MongoDB ID of the user receiving the notification
 * @param {string} title - Notification Title
 * @param {string} body - Notification Body message
 */
async function sendPushNotification(userId, title, body) {
  try {
    const user = await User.findById(userId);
    
    // Check if the user exists and actually has a push token saved from their phone
    if (user && user.expoPushToken) {
      await axios.post('https://exp.host/--/api/v2/push/send', {
        to: user.expoPushToken,
        sound: 'default',
        title: title,
        body: body,
        data: { screen: 'AppointmentsScreen' }, // Tells the app where to go when tapped!
      });
      console.log(`✅ Push sent to ${user.name}: "${title}"`);
    }
  } catch (error) {
    console.error('❌ Push Notification Error:', error.message);
  }
}

module.exports = sendPushNotification;