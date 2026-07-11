const cron = require('node-cron');
const CallRequest = require('../models/CallRequest');
const sendEmail = require('./emailHelper');

cron.schedule('0 * * * *', async () => {
  console.log('🧹 CRON: Running No-Show Cleanup Sweep...');
  try {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const abandonedSessions = await CallRequest.find({
      status: 'accepted',
      paymentStatus: 'paid',
      scheduledAt: { $lt: twentyFourHoursAgo }
    }).populate('requester', 'name email').populate('recipient', 'name email');

    if (abandonedSessions.length === 0) return;

    for (const session of abandonedSessions) {
      session.status = 'completed';
      session.paymentStatus = 'failed';
      if (session.zoomMeeting) session.zoomMeeting.status = 'expert_no_show';
      await session.save();

      const studentMessage = `Hi ${session.requester.name},\n\nWe noticed your scheduled session never took place. Your payment of ₹${session.amount} has been secured. Reply to this email for a refund.`;
      const expertMessage = `Hello ${session.recipient.name},\n\nYou missed your scheduled session. Your payout is cancelled.`;

      await Promise.all([
        sendEmail({ email: session.requester.email, subject: 'Refund Required', message: studentMessage }),
        sendEmail({ email: session.recipient.email, subject: 'Warning: Missed Session', message: expertMessage })
      ]);
    }
  } catch (error) { console.error('❌ CRON Error:', error); }
});