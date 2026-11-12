// backend/src/controllers/dashboardController.js
const mongoose = require('mongoose');
const CallRequest = require('../models/CallRequest');

exports.getExpertDashboard = async (req, res, next) => {
  try {
    const userId = new mongoose.Types.ObjectId(String(req.user._id || req.user.id));

    // Fetch all sessions where this user is the Mentor (recipient)
    const expertRequests = await CallRequest.collection
      .find({ recipient: userId })
      .toArray();

    let totalEarnings = 0;
    let totalCalls = 0;
    let upcomingSessions = 0;
    let withdrawableGross = 0;

    // 1. Setup Dynamic Chart Arrays (Last 6 Months)
    const monthNames = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const chartLabels = [];
    const chartData = [0, 0, 0, 0, 0, 0];

    const today = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      chartLabels.push(monthNames[d.getMonth()]);
    }

    // 2. Process mentor earnings & stats
    expertRequests.forEach((request) => {
      const isPaidOrProcessing = [
        'paid',
        'payout_ready',
        'payout_processing',
        'paid_out',
      ].includes(request.paymentStatus);

      const isNotExpertNoShow =
        request.videoSession?.status !== 'expert_no_show' &&
        request.zoomMeeting?.status !== 'expert_no_show';

      if (request.status === 'completed' && isPaidOrProcessing && isNotExpertNoShow) {
        const amt = Number(request.amount) || 0;
        totalEarnings += amt;
        totalCalls += 1;

        const requestDate = new Date(request.scheduledAt || request.createdAt);
        const monthDiff =
          (today.getFullYear() - requestDate.getFullYear()) * 12 +
          (today.getMonth() - requestDate.getMonth());

        if (monthDiff >= 0 && monthDiff < 6) {
          const index = 5 - monthDiff;
          chartData[index] += amt;
        }
      }

      const isUnwithdrawn = ['paid', 'payout_ready'].includes(request.paymentStatus);
      const hasValidPayment =
        Boolean(request.razorpayPaymentId) || request.paymentStatus === 'payout_ready';

      if (
        request.status === 'completed' &&
        isUnwithdrawn &&
        hasValidPayment &&
        isNotExpertNoShow
      ) {
        withdrawableGross += Number(request.amount) || 0;
      }

      if (request.status === 'accepted') {
        upcomingSessions += 1;
      }
    });

    // 3. Calculate Student Refundable Balance (Paid sessions that were cancelled/rejected/expert_no_show)
    const refundableSessions = await CallRequest.collection
      .find({
        requester: userId,
        razorpayPaymentId: { $exists: true, $nin: [null, ''] },
        paymentStatus: { $in: ['paid', 'failed'] },
        $or: [
          { status: { $in: ['cancelled', 'rejected'] } },
          { 'videoSession.status': 'expert_no_show' },
          { 'zoomMeeting.status': 'expert_no_show' },
        ],
      })
      .toArray();

    const refundableAmount = refundableSessions.reduce(
      (sum, item) => sum + Math.max(0, Number(item.amount) || 0),
      0
    );

    // 4. Recent Bookings (Both as Mentor and as Student so Transaction History works for everyone)
    const recentRaw = await CallRequest.collection
      .find({
        $or: [{ recipient: userId }, { requester: userId }],
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();

    const recentIds = recentRaw.map((r) => r._id);
    const recentBookings = [];
    for (const id of recentIds) {
      const populated = await CallRequest.findById(id)
        .populate('requester', 'name email')
        .populate('recipient', 'name email');
      if (populated) recentBookings.push(populated);
    }

    res.status(200).json({
      success: true,
      data: {
        stats: {
          totalEarnings,
          withdrawableGross,
          totalCalls,
          upcomingSessions,
        },
        refundStats: {
          refundableAmount,
          cancelledCount: refundableSessions.length,
        },
        recentBookings,
        chartLabels,
        chartData,
      },
    });
  } catch (error) {
    next(error);
  }
};