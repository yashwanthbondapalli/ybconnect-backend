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