const cron = require('node-cron');
const CallRequest = require('../models/CallRequest');
const sendEmail = require('./emailHelper');

// 🚨 RUNS AT MIDNIGHT EVERY DAY
cron.schedule('0 0 * * *', async () => {
  try {
    // 🚨 UPDATED LOGIC: Look for sessions scheduled over 24 hours ago
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    console.log('🧪 DAILY CRON: Running Abandoned Session Cleanup...');

    const abandonedSessions = await CallRequest.find({
      status: 'accepted',
      paymentStatus: 'paid', 
      scheduledAt: { $lt: oneDayAgo } // Finds sessions older than 24 hours
    }).populate('requester', 'name email').populate('recipient', 'name email');

    if (abandonedSessions.length === 0) {
      console.log('✅ No abandoned sessions found.');
      return;
    }

    for (const session of abandonedSessions) {
      session.status = 'completed';
      
      const expertShowedUp = session.zoomMeeting && session.zoomMeeting.expertJoinedAt;

      if (expertShowedUp) {
        // 🏆 EXPERT PAID: Student ghosted, Expert waited.
        session.paymentStatus = 'payout_ready'; 
        session.zoomMeeting.status = 'student_no_show';
        await session.save();
        console.log(`✅ Expert Paid for session ${session._id}: Student No-Show.`);
      } else {
        // 🚫 STUDENT REFUNDED: Total No-Show (Expert didn't join either).
        session.paymentStatus = 'failed';
        if (session.zoomMeeting) session.zoomMeeting.status = 'expert_no_show';
        await session.save();
        console.log(`✅ Student Refunded for session ${session._id}: Total No-Show.`);
      }
    }
  } catch (error) { 
    console.error('❌ CRON Error:', error); 
  }
});

// 🚨 RUNS EVERY 1 MINUTE TO CHECK FOR MEETINGS STARTING IN 5 MINS
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    // Look for sessions starting between 4 and 5 minutes from right now
    const inFiveMins = new Date(now.getTime() + 5 * 60000);
    const inFourMins = new Date(now.getTime() + 4 * 60000);

    const upcomingSessions = await CallRequest.find({
      status: 'accepted',
      paymentStatus: 'paid',
      scheduledAt: { $gt: inFourMins, $lte: inFiveMins },
      reminderEmailSent: { $ne: true } // Prevents spamming them every minute!
    }).populate('requester', 'name email').populate('recipient', 'name email');

    for (const session of upcomingSessions) {
      // Ensure the Zoom links actually exist before sending the email
      if (session.zoomMeeting && session.zoomMeeting.startUrl) {
        
        // 1. Send Email to EXPERT (Host Link)
        await sendEmail({
          email: session.recipient.email,
          subject: '🚨 Session Starts in 5 Minutes!',
          message: `Hi ${session.recipient.name},\n\nYour student ${session.requester.name} is waiting! Your session starts in 5 minutes.\n\nStart the meeting here: ${session.zoomMeeting.startUrl}\n\nHave a great session!`
        });

        // 2. Send Email to STUDENT (Join Link)
        await sendEmail({
          email: session.requester.email,
          subject: '🚨 Session Starts in 5 Minutes!',
          message: `Hi ${session.requester.name},\n\nYour mentor ${session.recipient.name} is ready! Your session starts in 5 minutes.\n\nJoin the meeting here: ${session.zoomMeeting.joinUrl}\n\nHave a great session!`
        });

        console.log(`✅ 5-Min Reminders sent for session ${session._id}`);
        
        // Mark as sent so we don't send it again
        session.reminderEmailSent = true;
        await session.save();
      }
    }
  } catch (error) {
    console.error('❌ 5-Min Reminder Cron Error:', error);
  }
});