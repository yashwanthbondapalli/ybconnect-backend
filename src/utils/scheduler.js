// backend/src/utils/scheduler.js
const cron = require('node-cron');
const axios = require('axios');
const CallRequest = require('../models/CallRequest');
const User = require('../models/User');
const sendEmail = require('./emailHelper');
const sendPushNotification = require('./pushHelper');
const { evaluateSessionState } = require('./livekitHelper');

// --- HELPER: BROADCAST ENGAGEMENT NOTIFICATIONS ---
async function sendEngagementNotification(title, messagesArray) {
  try {
    const randomMessage = messagesArray[Math.floor(Math.random() * messagesArray.length)];
    const users = await User.find({
      expoPushToken: { $exists: true, $ne: null,$ne: '' },
    });

    if (!users || users.length === 0) return;

    for (const user of users) {
      const activeToken = user.expoPushToken;
      if (
        activeToken &&
        typeof activeToken === 'string' &&
        activeToken.startsWith('ExponentPushToken')
      ) {
        await axios
          .post('https://exp.host/--/api/v2/push/send', {
            to: activeToken,
            sound: 'default',
            title,
            body: randomMessage,
            data: { screen: 'Home' },
          })
          .catch(() => {});
      }
    }
  } catch (error) {
    console.error('❌ Error sending engagement notifications:', error);
  }
}

// 1. MORNING ENGAGEMENT CRON (9:00 AM IST)
cron.schedule(
  '0 9 * * *',
  async () => {
    const morningMessages = [
      'Rise and grind! 🚀 Got a burning career question? Connect with a mentor on YB Connect right now!',
      'Good morning, achiever! ☕ Your future self is begging you to learn something new today. Jump into YB Connect!',
      "Morning! The coffee is brewing, and top tech mentors are online. Don't ghost your dreams today! 👀",
      "Wake up! ⚡ Greatness doesn't wait around. See what mentors and student talents are up to today!",
      'Warning: Staying in bed too long causes a lack of success. Fix it by booking a quick 1:1 session! 🎯',
    ];
    await sendEngagementNotification('YB Connect ☀️', morningMessages);
  },
  { timezone: 'Asia/Kolkata' }
);

// 2. NOON ENGAGEMENT CRON (12:00 PM IST)
cron.schedule(
  '0 12 * * *',
  async () => {
    const noonMessages = [
      'Good Afternoon, achiever! ☕ Your future self is begging you to learn something new today. Jump into YB Connect!',
      "Afternoon! Top tech mentors are online. Don't ghost your career goals today! 👀",
      'Book a quick 10 or 20-minute 1:1 mentorship call today and unblock your career! 🎯',
    ];
    await sendEngagementNotification('YB Connect ☀️', noonMessages);
  },
  { timezone: 'Asia/Kolkata' }
);

// 3. AFTERNOON ENGAGEMENT CRON (3:00 PM IST)
cron.schedule(
  '0 15 * * *',
  async () => {
    const afternoonMessages = [
      'Afternoon slump? Hit a roadblock in your code? 🛑 Unblock yourself instantly by talking to an expert!',
      "The day is halfway done! Have you built your network today? Tap in and see who's live right now! 🔥",
      "Quick reality check: You're one conversation away from a major breakthrough. Go check out YB Connect! 💡",
      "Mid-day motivation check! 🔋 Level up your portfolio before the sun goes down. Who's ready to chat?",
      'Stop scrolling, start learning, and see what awesome ideas people are posting on YB Connect! 🚀',
    ];
    await sendEngagementNotification('YB Connect ⚡', afternoonMessages);
  },
  { timezone: 'Asia/Kolkata' }
);

// =========================================================================
// 🚨 4. 5-MINUTE SESSION REMINDER CRON (Runs Every Minute)
// Sends both Email + Push Notification to Expert & Student
// =========================================================================
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const inSixMins = new Date(now.getTime() + 6 * 60 * 1000);

    const upcomingSessions = await CallRequest.find({
      status: 'accepted',
      paymentStatus: 'paid',
      scheduledAt: { $gt: now,$lte: inSixMins },
      reminderEmailSent: { $ne: true },
    })
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    for (const session of upcomingSessions) {
      // Lock flag first to prevent duplicate sends
      session.reminderEmailSent = true;
      await session.save();

      const durationMins = session.durationMinutes || 30;

      // Send Push Notifications to both parties
      await Promise.all([
        sendPushNotification(
          session.recipient._id,
          '🚨 Session Starts in 5 Minutes!',
          `Your ${durationMins}m call with ${session.requester.name} is unlocked! Tap Bookings to start the video call.`
        ),
        sendPushNotification(
          session.requester._id,
          '🚨 Session Starts in 5 Minutes!',
          `Your ${durationMins}m call with ${session.recipient.name} is unlocked! Tap Bookings to join the video call.`
        ),
      ]).catch(() => {});

      // Send Emails to both parties
      await Promise.all([
        sendEmail({
          email: session.recipient.email,
          subject: '🚨 Your YB Connect Session Starts in 5 Minutes!',
          message: `Hi ${session.recipient.name},\n\nYour student ${session.requester.name} is ready! Your ${durationMins}-minute 1:1 session ("${session.topic}") starts in 5 minutes.\n\n🎥 How to join:\nOpen the YB Connect app -> Go to the "Bookings" tab -> Tap "Start Video Call".\n\nHave a great mentorship session!`,
        }),
        sendEmail({
          email: session.requester.email,
          subject: '🚨 Your YB Connect Session Starts in 5 Minutes!',
          message: `Hi ${session.requester.name},\n\nYour mentor ${session.recipient.name} is ready! Your ${durationMins}-minute 1:1 session ("${session.topic}") starts in 5 minutes.\n\n🎥 How to join:\nOpen the YB Connect app -> Go to the "Bookings" tab -> Tap "Join Video Call".\n\nHave a great learning session!`,
        }),
      ]).catch((err) => {
        console.error(`Reminder email error for session ${session._id}:`, err.message);
      });

      console.log(`✅ 5-Min Reminders (Push + Email) sent for session ${session._id}`);
    }
  } catch (error) {
    console.error('❌ 5-Min Reminder Cron Error:', error);
  }
});

// =========================================================================
// 🚨 5. REAL-TIME SESSION COMPLETION & NO-SHOW RECONCILIATION (Every 2 Mins)
// Evaluates any session whose scheduledEndAt + 5m grace window has elapsed
// =========================================================================
cron.schedule('*/2 * * * *', async () => {
  try {
    const now = new Date();
    const fiveMinsAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // Find active paid sessions whose scheduledAt is in the past
    const candidateSessions = await CallRequest.find({
      status: 'accepted',
      paymentStatus: 'paid',
      scheduledAt: { $lt: fiveMinsAgo },
    })
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    for (const session of candidateSessions) {
      const startMs = new Date(session.scheduledAt).getTime();
      const durationMins = Number(session.durationMinutes) || 30;
      const endMs = session.scheduledEndAt
        ? new Date(session.scheduledEndAt).getTime()
        : startMs + durationMins * 60 * 1000;

      // Wait until scheduledEndAt + 5 minutes grace period has passed before final adjudication
      if (now.getTime() < endMs + 5 * 60 * 1000) {
        continue;
      }

      await evaluateSessionState(session, { isFinalCheck: true, referenceTime: now });
      session.markModified('videoSession');
      session.markModified('zoomMeeting');
      await session.save();

      const outcome = session.videoSession?.status || session.zoomMeeting?.status;
      console.log(`⚖️ Auto-Reconciled Session ${session._id}: outcome=${outcome}, payment=${session.paymentStatus}`);

      // Notify participants if an expert no-show triggered an automatic refund
      if (outcome === 'expert_no_show') {
        await Promise.all([
          sendPushNotification(
            session.requester._id,
            '🔄 Refund Credited to Wallet',
            `Your session with ${session.recipient.name} could not be completed. ₹${session.amount} has been credited to your Refund Wallet.`
          ),
          sendEmail({
            email: session.requester.email,
            subject: '🔄 Session Refund Credited to Your YB Connect Wallet',
            message: `Hi ${session.requester.name},\n\nBecause your scheduled session ("${session.topic}") with ${session.recipient.name} was not attended by the mentor, 100% of your payment (₹${session.amount}) has been credited to your Refund Wallet.\n\nYou can withdraw it directly from your Dashboard in the YB Connect app.\n\nThank you,\nYour YB Connect Team`,
          }),
        ]).catch(() => {});
      }
    }
  } catch (error) {
    console.error('❌ Session Reconciliation Cron Error:', error);
  }
});