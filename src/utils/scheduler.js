const cron = require('node-cron');
const CallRequest = require('../models/CallRequest');
const sendEmail = require('./emailHelper');

const axios = require('axios'); // Required to ping Expo's push endpoint

// --- HELPER FUNCTION: BROADCAST ENGAGEMENT NOTIFICATIONS ---
async function sendEngagementNotification(title, messagesArray) {
  try {
    // Pick a random crazy message from the array
    const randomMessage = messagesArray[Math.floor(Math.random() * messagesArray.length)];
    
    // Fetch all users who have registered an Expo push token
    const users = await User.find({ pushToken: { $exists: true, $ne: null } }).select('pushToken');
    
    if (!users || users.length === 0) {
      console.log('⚠️ No users with push tokens found for engagement broadcast.');
      return;
    }

    console.log(`📢 Broadcasting engagement notification to ${users.length} users...`);

    // Loop through users and send the push notification via Expo
    for (const user of users) {
      if (user.pushToken && user.pushToken.startsWith('ExponentPushToken')) {
        await axios.post('https://exp.host/--/api/v2/push/send', {
          to: user.pushToken,
          sound: 'default',
          title: title,
          body: randomMessage,
          data: { screen: 'Home' },
        }).catch(err => {
          // Silently catch individual token errors so one bad token doesn't crash the loop
          console.log(`Failed to push to token: ${user.pushToken}`);
        });
      }
    }
    console.log(`✅ Engagement broadcast sent: "${randomMessage}"`);
  } catch (error) {
    console.error('❌ Error sending engagement notifications:', error);
  }
}

// ==========================================
// 🌅 1. MORNING ENGAGEMENT CRON (Every day at 9:00 AM)
// ==========================================
cron.schedule('0 9 * * *', async () => {
  console.log('🌅 Running 9:00 AM Morning Engagement Push...');
  
  const morningMessages = [
    "Rise and grind! 🚀 Got a burning career question? Connect with a mentor on YB Connect right now!",
    "Good morning, achiever! ☕ Your future self is begging you to learn something new today. Jump into YB Connect!",
    "Morning! The coffee is brewing, and top tech mentors are online. Don't ghost your dreams today! 👀",
    "Wake up! ⚡ Greatness doesn't wait around. See what mentors and student talents are up to today!",
    "Warning: Staying in bed too long causes a lack of success. Fix it by booking a quick 1:1 session! 🎯"
  ];

  await sendEngagementNotification("YB Connect ☀️", morningMessages);
});

// ==========================================
// 🌇 2. AFTERNOON ENGAGEMENT CRON (Every day at 4:00 PM / 16:00)
// ==========================================
cron.schedule('0 16 * * *', async () => {
  console.log('🌇 Running 4:00 PM Afternoon Engagement Push...');
  
  const afternoonMessages = [
    "Afternoon slump? Hit a roadblock in your code? 🛑 Unblock yourself instantly by talking to an expert!",
    "The day is halfway done! Have you built your network today? Tap in and see who's live right now! 🔥",
    "Quick reality check: You're one conversation away from a major breakthrough. Go check out YB Connect! 💡",
    "Mid-day motivation check! 🔋 Level up your portfolio before the sun goes down. Who's ready to chat?",
    "Stop scrolling Instagram reels and go look at what awesome ideas people are posting on YB Connect! 🚀"
  ];

  await sendEngagementNotification("YB Connect ⚡", afternoonMessages);
});

// 🌙 RUNS EXACTLY AT 12:00 AM (MIDNIGHT) EVERY DAY
cron.schedule('0 0 * * *', async () => {
  try {
    const rightNow = new Date();
    console.log('🌙 12:00 AM CRON: Running Abandoned Session Cleanup...');

    const abandonedSessions = await CallRequest.find({
      status: 'accepted',
      paymentStatus: 'paid', 
      scheduledAt: { $lt: rightNow } 
    }).populate('requester', 'name email').populate('recipient', 'name email');

    if (abandonedSessions.length === 0) {
      console.log('✅ No abandoned sessions found at 12:00 AM.');
      return;
    }

    for (const session of abandonedSessions) {
      session.status = 'completed';
      
      const expertShowedUp = session.zoomMeeting && session.zoomMeeting.expertJoinedAt;

      if (expertShowedUp) {
        session.paymentStatus = 'payout_ready'; 
        session.zoomMeeting.status = 'student_no_show';
        await session.save();
        console.log(`✅ Expert Paid for session ${session._id}: Student No-Show.`);
      } else {
        session.paymentStatus = 'refunded';
        session.zoomMeeting.status = 'mutual_no_show';
        await session.save();
        console.log(`🔄 Refund issued for session ${session._id}: Mutual No-Show.`);
      }
    }
  } catch (error) {
    console.error('❌ Error in abandoned session cron:', error);
  }
});

// ... Keep your 5-minute reminder cron exactly as it is below this! ...

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