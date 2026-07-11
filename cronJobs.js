// cronJobs.js
const cron = require('node-cron');

// 🚨 FIX: Tell Node to look inside the 'src' folder!
const CallRequest = require('./src/models/CallRequest'); 
const sendEmail = require('./src/utils/emailHelper');

// This code runs automatically EVERY MINUTE ('* * * * *')
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    // Look 6 minutes into the future
    const fiveMinutesFromNow = new Date(now.getTime() + 6 * 60000); 

    // Find all requests that are PAID, haven't had a reminder sent, 
    // and are scheduled to start between NOW and 6 minutes from now.
    const upcomingSessions = await CallRequest.find({
      paymentStatus: 'paid',
      reminderEmailSent: false,
      scheduledAt: { $gte: now, $lte: fiveMinutesFromNow }
    })
    .populate('requester', 'name email')
    .populate('recipient', 'name email');

    for (const session of upcomingSessions) {
      const zoomLinkHost = session.zoomMeeting?.startUrl || 'Link will appear in app';
      const zoomLinkGuest = session.zoomMeeting?.joinUrl || 'Link will appear in app';

      // 1. Mail to Student
      await sendEmail({
        email: session.requester.email,
        subject: '🚨 Your BacktoBase Session starts in 5 minutes!',
        message: `Hi ${session.requester.name},\n\nGet ready! Your session with ${session.recipient.name} starts in 5 minutes.\n\nJoin here: ${zoomLinkGuest}\n\nSee you there!`
      });

      // 2. Mail to Expert
      await sendEmail({
        email: session.recipient.email,
        subject: '🚨 Your BacktoBase Session starts in 5 minutes!',
        message: `Hi ${session.recipient.name},\n\nYour student ${session.requester.name} is waiting! Your session starts in 5 minutes.\n\nStart the meeting here: ${zoomLinkHost}\n\nHave a great session!`
      });

      // 3. Mark as sent so we don't spam them on the next minute tick
      session.reminderEmailSent = true;
      await session.save();
      
      console.log(`⏰ 5-Min Reminder emails sent for session ${session._id}`);
    }
  } catch (error) {
    console.error('Cron Job Error:', error);
  }
});