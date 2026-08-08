const cron = require('node-cron');
const CallRequest = require('../models/CallRequest');
const User = require('../models/User'); 
const sendEmail = require('./emailHelper');
const axios = require('axios'); // Required to ping Expo's push endpoint

// --- HELPER FUNCTION: BROADCAST ENGAGEMENT NOTIFICATIONS ---
// --- HELPER FUNCTION: BROADCAST ENGAGEMENT NOTIFICATIONS ---
async function sendEngagementNotification(title, messagesArray) {
  try {
    // Pick a random crazy message from the array
    const randomMessage = messagesArray[Math.floor(Math.random() * messagesArray.length)];
    
    // 🚨 FIX: Target the exact field name found in your schema: 'expoPushToken'
    const users = await User.find({
      expoPushToken: { $exists: true, $ne: null, $ne: '' }
    });
    
    if (!users || users.length === 0) {
      console.log('⚠️ No users found with a valid "expoPushToken" in MongoDB yet.');
      return;
    }

    console.log(`📢 Broadcasting engagement notification to ${users.length} user(s)...`);

    for (const user of users) {
      const activeToken = user.expoPushToken;

      if (activeToken && typeof activeToken === 'string' && activeToken.startsWith('ExponentPushToken')) {
        await axios.post('https://exp.host/--/api/v2/push/send', {
          to: activeToken,
          sound: 'default',
          title: title,
          body: randomMessage,
          data: { screen: 'Home' },
        }).catch(err => {
          console.log(`Failed to push to token: ${activeToken}`, err.message);
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
},
  {
  timezone: "Asia/Kolkata" // 🚨 THIS FIXES THE TIMEZONE
});

cron.schedule('0 12 * * *', async () => {
  console.log('🌅 Running 9:00 AM Morning Engagement Push...');
  
  const morningMessages = [
    "Rise and grind! 🚀 Got a burning career question? Connect with a mentor on YB Connect right now!",
    "Good Afternoon, achiever! ☕ Your future self is begging you to learn something new today. Jump into YB Connect!",
    "Afternoon! The coffee is brewing, and top tech mentors are online. Don't ghost your dreams today! 👀",
    "Wake up! ⚡ Greatness doesn't wait around. See what mentors and student talents are up to today!",
    "Warning: Staying in bed too long causes a lack of success. Fix it by booking a quick 1:1 session! 🎯"
  ];

  await sendEngagementNotification("YB Connect ☀️", morningMessages);
},
  {
  timezone: "Asia/Kolkata" // 🚨 THIS FIXES THE TIMEZONE
});

// ==========================================
// 🌇 2. AFTERNOON ENGAGEMENT CRON (Every day at 4:00 PM / 16:00)
// ==========================================
cron.schedule('0 15 * * *', async () => {
  console.log('🌇 Running 3:00 PM Afternoon Engagement Push...');
  
  const afternoonMessages = [
    "Afternoon slump? Hit a roadblock in your code? 🛑 Unblock yourself instantly by talking to an expert!",
    "The day is halfway done! Have you built your network today? Tap in and see who's live right now! 🔥",
    "Quick reality check: You're one conversation away from a major breakthrough. Go check out YB Connect! 💡",
    "Mid-day motivation check! 🔋 Level up your portfolio before the sun goes down. Who's ready to chat?",
    "Stop scrolling start learning and go look at what awesome ideas people are posting on YB Connect! 🚀"
  ];

  await sendEngagementNotification("YB Connect ⚡", afternoonMessages);
},

{
  timezone: "Asia/Kolkata" // 🚨 THIS FIXES THE TIMEZONE
}

);

// ==========================================
// 🌙 3. ABANDONED SESSION CLEANUP (12:00 AM Midnight Every Day)
// ==========================================
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

// ==========================================
// 🧪 4. TEMPORARY TEST CRON (Runs EVERY MINUTE for live testing)
// ==========================================
//cron.schedule('* * * * *', async () => {
 // console.log('🧪 TEST CRON: Triggering test notification right now...');
  
  //const testMessages = [
  //  "Test notification! If you see this, your push system is 100% working! 🚀",
  //  "It's working! Your YB Connect push notifications are fully alive. 🔥"
  //];

 // await sendEngagementNotification("YB Connect Test ⚡", testMessages);
//});

// ==========================================
// 🚨 5. 5-MINUTE MEETING REMINDER CRON (Runs Every Minute)
// ==========================================
cron.schedule('* * * * *', async () => {
  try {
    const now = new Date();
    const inFiveMins = new Date(now.getTime() + 5 * 60000);
    const inFourMins = new Date(now.getTime() + 4 * 60000);

    const upcomingSessions = await CallRequest.find({
      status: 'accepted',
      paymentStatus: 'paid',
      scheduledAt: { $gt: inFourMins, $lte: inFiveMins },
      reminderEmailSent: { $ne: true } 
    }).populate('requester', 'name email').populate('recipient', 'name email');

    for (const session of upcomingSessions) {
      if (session.zoomMeeting && session.zoomMeeting.startUrl) {
        
        await sendEmail({
          email: session.recipient.email,
          subject: '🚨 Session Starts in 5 Minutes!',
          message: `Hi ${session.recipient.name},\n\nYour student ${session.requester.name} is waiting! Your session starts in 5 minutes.\n\nStart the meeting here: ${session.zoomMeeting.startUrl}\n\nHave a great session!`
        });

        await sendEmail({
          email: session.requester.email,
          subject: '🚨 Session Starts in 5 Minutes!',
          message: `Hi ${session.requester.name},\n\nYour mentor ${session.recipient.name} is ready! Your session starts in 5 minutes.\n\nJoin the meeting here: ${session.zoomMeeting.joinUrl}\n\nHave a great session!`
        });

        console.log(`✅ 5-Min Reminders sent for session ${session._id}`);
        
        session.reminderEmailSent = true;
        await session.save();
      }
    }
  } catch (error) {
    console.error('❌ 5-Min Reminder Cron Error:', error);
  }
});