// src/controllers/dashboardController.js
const CallRequest = require('../models/CallRequest');

exports.getExpertDashboard = async (req, res, next) => {
  try {
    const expertId = req.user.id;
    const allRequests = await CallRequest.find({ recipient: expertId });

    let totalEarnings = 0;
    let totalCalls = 0;
    let upcomingSessions = 0;
    
    let withdrawableGross = 0; 

    // 1. Setup Dynamic Chart Arrays (Last 6 Months)
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const chartLabels = [];
    const chartData = [0, 0, 0, 0, 0, 0]; 

    const today = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      chartLabels.push(monthNames[d.getMonth()]); 
    }

    // 2. Process all requests and bucket the money
    allRequests.forEach(request => {
      
      const isPaidOrProcessing = ['paid', 'payout_ready', 'payout_processing'].includes(request.paymentStatus);
      
      if (request.status === 'completed' && isPaidOrProcessing) {
        totalEarnings += request.amount || 0;
        totalCalls += 1;

        const requestDate = new Date(request.scheduledAt || request.createdAt);
        const monthDiff = (today.getFullYear() - requestDate.getFullYear()) * 12 + (today.getMonth() - requestDate.getMonth());

        if (monthDiff >= 0 && monthDiff < 6) {
          const index = 5 - monthDiff;
          chartData[index] += request.amount || 0;
        }
      }

      // 🚨 THE FIX: We now accept BOTH 'paid' and 'payout_ready' as withdrawable!
      // This means manual testing works perfectly now.
      const isUnwithdrawn = ['paid', 'payout_ready'].includes(request.paymentStatus);
      
      if (request.status === 'completed' && isUnwithdrawn) {
        withdrawableGross += request.amount || 0;
      }

      if (request.status === 'accepted') {
        upcomingSessions += 1;
      }
    });

    const recentBookings = await CallRequest.find({ recipient: expertId })
      .populate('requester', 'name email')
      .sort({ createdAt: -1 })
      .limit(5);

    res.status(200).json({
      success: true,
      data: {
        stats: { totalEarnings, withdrawableGross, totalCalls, upcomingSessions },
        recentBookings,
        chartLabels, 
        chartData    
      }
    });

  } catch (error) {
    next(error);
  }
};