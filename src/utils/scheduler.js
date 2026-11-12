// backend/src/utils/scheduler.js
const cron = require('node-cron');
const axios = require('axios');
const CallRequest = require('../models/CallRequest');
const User = require('../models/User');
const sendEmail = require('./emailHelper');
const sendPushNotification = require('./pushHelper');
const { evaluateSessionState } = require('./livekitHelper');

async function sendEngagementNotification(title, messagesArray) {
  try {
    const randomMessage =
      messagesArray[Math.floor(Math.random() * messagesArray.length)];

    // Native collection query avoids Mongoose CastErrors on $ne / $nin / $exists
    const users = await User.collection
      .find(
        {
          isDeleted: { $ne: true },
          accountStatus: 'active',
          expoPushToken: { $exists: true, $nin: [null, ''] },
        },
        { projection: { expoPushToken: 1 } }
      )
      .toArray();

    if (!users || users.length === 0) return;

    const validPayloads = users
      .map((u) => u.expoPushToken)
      .filter(
        (token) =>
          typeof token === 'string' && token.startsWith('ExponentPushToken')
      )
      .map((token) => ({
        to: token,
        sound: 'default',
        title,
        body: randomMessage,
        data: { screen: 'Home' },
      }));

    const BATCH_SIZE = 100;
    for (let i = 0; i < validPayloads.length; i += BATCH_SIZE) {
      const chunk = validPayloads.slice(i, i + BATCH_SIZE);
      await axios
        .post('https://exp.host/--/api/v2/push/send', chunk, {
          timeout: 10000,
        })
        .catch(() => {});
    }
  } catch (error) {
    console.error('❌ Error sending engagement notifications:', error.message);
  }
}

// =========================================================================
// 1. MORNING ENGAGEMENT CRON (9:00 AM IST)
// =========================================================================
cron.schedule(
  '0 9 * * *',
  async () => {
    const morningMessages = [
      'Rise and grind! 🚀 Got a burning career question? Connect with a mentor on YB Connect right now!',
      'Good morning, achiever! ☕ Your future self is begging you to learn something new today. Jump into YB Connect!',
      "Morning! The coffee is brewing, and top tech mentors are online. Don't ghost your dreams today! 👀",
    ];
    await sendEngagementNotification('YB Connect ☀️', morningMessages);
  },
  { timezone: 'Asia/Kolkata' }
);

// =========================================================================
// 2. NOON ENGAGEMENT CRON (12:00 PM IST)
// =========================================================================
cron.schedule(
  '0 12 * * *',
  async () => {
    const noonMessages = [
      'Good Afternoon, achiever! ☕ Your future self is begging you to learn something new today. Jump into YB Connect!',
      "Afternoon! Top tech mentors are online. Don't ghost your career goals today! 👀",
    ];
    await sendEngagementNotification('YB Connect ☀️', noonMessages);
  },
  { timezone: 'Asia/Kolkata' }
);

// =========================================================================
// 3. AFTERNOON ENGAGEMENT CRON (3:00 PM IST)
// =========================================================================
cron.schedule(
  '0 15 * * *',
  async () => {
    const afternoonMessages = [
      'Afternoon slump? Hit a roadblock in your code? 🛑 Unblock yourself instantly by talking to an expert!',
      "The day is halfway done! Have you built your network today? Tap in and see who's live right now! 🔥",
    ];
    await sendEngagementNotification('YB Connect ⚡', afternoonMessages);
  },
  { timezone: 'Asia/Kolkata' }
);

// =========================================================================
// 4. 5-MINUTE SESSION REMINDER CRON (Runs Every Minute)
// =========================================================================
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const inSixMins = new Date(now.getTime() + 6 * 60 * 1000);

    // Native collection find bypasses Mongoose date & boolean operator casting
    const rawCandidates = await CallRequest.collection
      .find({
        status: 'accepted',
        paymentStatus: 'paid',
        scheduledAt: { $gt: now, $lte: inSixMins },
        $or: [
          { reminderEmailSent: { $ne: true } },
          { reminderEmailSent: { $exists: false } },
        ],
      })
      .toArray();

    for (const item of rawCandidates) {
      // Atomically mark reminderEmailSent = true via native updateOne
      const lockResult = await CallRequest.collection.updateOne(
        {
          _id: item._id,
          $or: [
            { reminderEmailSent: { $ne: true } },
            { reminderEmailSent: { $exists: false } },
          ],
        },
        { $set: { reminderEmailSent: true } }
      );

      if (!lockResult.modifiedCount) continue;

      const session = await CallRequest.findById(item._id)
        .populate('requester', 'name email')
        .populate('recipient', 'name email');

      if (!session || !session.requester || !session.recipient) continue;

      const durationMins = session.durationMinutes || 30;

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

      await Promise.all([
        session.recipient.email &&
          sendEmail({
            email: session.recipient.email,
            subject: '🚨 Your YB Connect Session Starts in 5 Minutes!',
            message: `Hi ${session.recipient.name},\n\nYour student ${session.requester.name} is ready! Your ${durationMins}-minute 1:1 session ("${session.topic}") starts in 5 minutes.\n\n🎥 How to join:\nOpen the YB Connect app -> Go to the "Bookings" tab -> Tap "Start Video Call".\n\nHave a great mentorship session!`,
          }),
        session.requester.email &&
          sendEmail({
            email: session.requester.email,
            subject: '🚨 Your YB Connect Session Starts in 5 Minutes!',
            message: `Hi ${session.requester.name},\n\nYour mentor ${session.recipient.name} is ready! Your ${durationMins}-minute 1:1 session ("${session.topic}") starts in 5 minutes.\n\n🎥 How to join:\nOpen the YB Connect app -> Go to the "Bookings" tab -> Tap "Join Video Call".\n\nHave a great learning session!`,
          }),
      ]).catch((err) => {
        console.error(
          `Reminder email error for session ${session._id}:`,
          err.message
        );
      });
    }
  } catch (error) {
    console.error('❌ 5-Min Reminder Cron Error:', error.message);
  }
});

// =========================================================================
// 5. REAL-TIME SESSION COMPLETION, NO-SHOW & UNPAID EXPIRY CRON (Every 2 Mins)
// =========================================================================
cron.schedule('*/2 * * * *', async () => {
  try {
    const now = new Date();
    const fiveMinsAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // 5A. Auto-cancel unpaid bookings whose scheduled start time has already passed
    await CallRequest.collection.updateMany(
      {
        status: { $in: ['pending', 'holding', 'offer_made', 'accepted'] },
        paymentStatus: 'pending',
        scheduledAt: { $lt: fiveMinsAgo },
      },
      {
        $set: {
          status: 'cancelled',
          cancelledBy: 'system',
          cancelReason: 'Expired without payment before scheduled start time',
          cancelledAt: now,
        },
      }
    );

    // 5B. Reconcile paid sessions whose scheduledAt is in the past
    const rawReconcile = await CallRequest.collection
      .find({
        status: 'accepted',
        paymentStatus: 'paid',
        scheduledAt: { $lt: fiveMinsAgo },
      })
      .toArray();

    if (rawReconcile.length === 0) return;

    for (const rawItem of rawReconcile) {
      const session = await CallRequest.findById(rawItem._id)
        .populate('requester', 'name email')
        .populate('recipient', 'name email');

      if (!session) continue;

      const startMs = new Date(session.scheduledAt).getTime();
      const durationMins = Number(session.durationMinutes) || 30;
      const endMs = session.scheduledEndAt
        ? new Date(session.scheduledEndAt).getTime()
        : startMs + durationMins * 60 * 1000;

      // Wait until at least 5 minutes after the session's scheduled end time before final evaluation
      if (now.getTime() < endMs + 5 * 60 * 1000) {
        continue;
      }

      await evaluateSessionState(session, {
        isFinalCheck: true,
        referenceTime: now,
      });
      session.markModified('videoSession');
      session.markModified('zoomMeeting');
      await session.save();

      const outcome =
        session.videoSession?.status || session.zoomMeeting?.status;

      if (outcome === 'expert_no_show' && session.requester) {
        const mentorName = session.recipient?.name || 'your mentor';
        await Promise.all([
          sendPushNotification(
            session.requester._id,
            '🔄 Refund Credited to Wallet',
            `Your session with ${mentorName} could not be completed. ₹${session.amount} has been credited to your Refund Wallet.`
          ),
          session.requester.email &&
            sendEmail({
              email: session.requester.email,
              subject:
                '🔄 Session Refund Credited to Your YB Connect Wallet',
              message: `Hi ${session.requester.name},\n\nBecause your scheduled session ("${session.topic}") with ${mentorName} was not completed by the mentor, 100% of your payment (₹${session.amount}) has been credited to your Refund Wallet.\n\nYou can withdraw it directly from your Dashboard in the YB Connect app.\n\nThank you,\nYour YB Connect Team`,
            }),
        ]).catch(() => {});
      }
    }
  } catch (error) {
    console.error('❌ Session Reconciliation Cron Error:', error.message);
  }
});

module.exports = {};