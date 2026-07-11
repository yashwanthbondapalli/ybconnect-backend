const cron = require('node-cron');
const CallRequest = require('../models/CallRequest');
const sendEmail = require('./emailHelper');

// 🚨 TEMPORARY TEST CONFIG: Runs every 1 minute
cron.schedule('*/20 * * * *', async () => {
 
  try {
    // 🚨 TEMPORARY TEST CONFIG: Looks for sessions exactly 5 minutes old
    const fiveMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
     console.log('🧪 TEST CRON: Running 30-Minute Cleanup Sweep...');
    const abandonedSessions = await CallRequest.find({
      status: 'accepted',
      paymentStatus: 'paid', 
      scheduledAt: { $lt: fiveMinutesAgo }
    }).populate('requester', 'name email').populate('recipient', 'name email');

    if (abandonedSessions.length === 0) return;

    for (const session of abandonedSessions) {
      session.status = 'completed';
      
      const expertShowedUp = session.zoomMeeting && session.zoomMeeting.expertJoinedAt;

      if (expertShowedUp) {
        // 🏆 EXPERT PAID: Student ghosted, Expert waited.
        session.paymentStatus = 'payout_ready'; 
        session.zoomMeeting.status = 'student_no_show';
        await session.save();
        console.log(`✅ TEST: Expert Paid! Student No-Show processed.`);
        // (Email functions remain exactly the same here)
      } else {
        // 🚫 STUDENT REFUNDED: Total No-Show.
        session.paymentStatus = 'failed';
        if (session.zoomMeeting) session.zoomMeeting.status = 'expert_no_show';
        await session.save();
        console.log(`✅ TEST: Student Refunded! Total No-Show processed.`);
        // (Email functions remain exactly the same here)
      }
    }
  } catch (error) { console.error('❌ CRON Error:', error); }
});