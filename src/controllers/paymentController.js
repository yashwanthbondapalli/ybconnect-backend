// backend/src/controllers/paymentController.js
const Razorpay = require('razorpay');
const crypto = require('crypto');
const mongoose = require('mongoose');
const CallRequest = require('../models/CallRequest');
const Profile = require('../models/Profile');
const Payout = require('../models/Payout');
const sendEmail = require('../utils/emailHelper');
const sendPushNotification = require('../utils/pushHelper');
const { ensureBookingVideoSession } = require('../utils/livekitHelper');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error('⛔ FATAL ERROR: Razorpay API keys are missing from your .env file!');
}

// 1. Create a Razorpay Order & Provision LiveKit Video Room
exports.createOrder = async (req, res) => {
  try {
    const { requestId } = req.body;
    const callRequest = await CallRequest.findById(requestId);

    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    // IDOR Protection: Only the student who created the request can pay
    if (callRequest.requester.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'Security Alert: You are not authorized to pay for this session.',
      });
    }

    if (callRequest.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, error: 'This session is already paid for.' });
    }

    if (!callRequest.amount || callRequest.amount <= 0 || isNaN(callRequest.amount)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid session amount. The expert needs to set a valid price.',
      });
    }

    const expertProfile = await Profile.findOne({ user: callRequest.recipient });
    if (!expertProfile) {
      return res.status(400).json({
        success: false,
        error: 'Expert profile not found.',
      });
    }

    // Provision LiveKit Room on the booking (zero external OAuth dependency)
    ensureBookingVideoSession(callRequest);

    const totalAmountPaise = Math.round(callRequest.amount * 100);
    const options = {
      amount: totalAmountPaise,
      currency: 'INR',
      receipt: `receipt_req_${requestId}`,
    };

    const order = await razorpay.orders.create(options);

    callRequest.razorpayOrderId = order.id;
    await callRequest.save();

    res.status(200).json({
      success: true,
      order,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('Order Creation Error:', error);
    res.status(500).json({ success: false, error: 'Failed to create payment order.' });
  }
};

// 2. Verify Razorpay Payment Signature & Confirm Booking
exports.verifyPayment = async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, requestId } = req.body;

    const callRequest = await CallRequest.findById(requestId);
    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    if (callRequest.requester.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'You are not authorized to verify this payment.',
      });
    }

    if (callRequest.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        error: 'Order ID mismatch. Payment verification failed.',
      });
    }

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Signature. Payment Fraud Detected.',
      });
    }

    // 1. Update payment & booking status and disarm the 10-minute TTL timer
    callRequest.paymentStatus = 'paid';
    callRequest.razorpayPaymentId = razorpay_payment_id;
    callRequest.status = 'accepted';
    callRequest.expiresAt = undefined;
    ensureBookingVideoSession(callRequest);

    await callRequest.save();

    const populatedRequest = await CallRequest.findById(requestId)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

    // 2. Send Confirmation Emails & Push Notification in IST
    try {
      const formattedISTTime = new Date(populatedRequest.scheduledAt).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });

      const durationMins = populatedRequest.durationMinutes || 30;

      const expertMessage = `Hello ${populatedRequest.recipient.name},\n\nGreat news! ${populatedRequest.requester.name} has booked and paid ₹${populatedRequest.amount} for a ${durationMins}-minute 1:1 session with you.\n\nSession Topic: ${populatedRequest.topic}\nScheduled Time: ${formattedISTTime} (IST)\n\n🎥 Your in-app video room will unlock 5 minutes before the session starts inside the YB Connect app (Bookings tab). You will also receive a reminder 5 minutes prior.\n\nThank you for mentoring on YB Connect!`;

      const studentMessage = `Hi ${populatedRequest.requester.name},\n\nPayment Successful! Your ${durationMins}-minute 1:1 session is confirmed.\n\nReceipt Details:\n- Amount Paid: ₹${populatedRequest.amount}\n- Mentor: ${populatedRequest.recipient.name}\n- Duration: ${durationMins} Minutes\n- Session Time: ${formattedISTTime} (IST)\n- Transaction ID: ${razorpay_payment_id}\n\n🎥 Your in-app video call button will unlock 5 minutes before the session starts inside the YB Connect app (Bookings tab).\n\nThank you for using YB Connect!`;

      await Promise.all([
        sendEmail({
          email: populatedRequest.recipient.email,
          subject: '💰 New Booking Confirmed - Payment Received!',
          message: expertMessage,
        }),
        sendEmail({
          email: populatedRequest.requester.email,
          subject: '🧾 Booking Confirmed & Payment Receipt',
          message: studentMessage,
        }),
        sendPushNotification(
          populatedRequest.recipient._id,
          '💰 New Session Booked! 🎉',
          `${populatedRequest.requester.name} booked a ${durationMins}m session (₹${populatedRequest.amount}) for ${formattedISTTime}.`
        ),
      ]);
    } catch (emailErr) {
      console.error('Notification error after successful payment:', emailErr.message);
    }

    res.status(200).json({
      success: true,
      message: 'Payment verified and video session confirmed!',
    });
  } catch (error) {
    next(error);
  }
};

// 3. Save Bank Details for Admin Manual Payout
exports.createLinkedAccount = async (req, res) => {
  try {
    const { accountNumber, ifscCode } = req.body;
    const userId = req.user._id;

    const updatedProfile = await Profile.findOneAndUpdate(
      { user: userId },
      {
        accountNumber,
        ifscCode,
        isPayoutActive: true,
        razorpayAccountId: 'manual_payout_mode',
      },
      { new: true }
    );

    if (!updatedProfile) {
      return res.status(404).json({ success: false, error: 'Profile not found.' });
    }

    res.status(200).json({
      success: true,
      message: 'Bank account linked securely for payouts!',
      accountId: 'manual_payout_mode',
    });
  } catch (error) {
    console.error('Bank Save Error:', error);
    res.status(500).json({ success: false, error: 'Failed to vault bank details.' });
  }
};

// 4. Release Escrow
exports.releaseEscrow = async (req, res, next) => {
  try {
    const { requestId } = req.body;
    const callRequest = await CallRequest.findById(requestId);

    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    const userIdStr = req.user._id.toString();
    if (
      callRequest.requester.toString() !== userIdStr &&
      callRequest.recipient.toString() !== userIdStr
    ) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (callRequest.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Session must be completed first.' });
    }

    callRequest.paymentStatus = 'payout_ready';
    await callRequest.save();

    res.status(200).json({
      success: true,
      message: 'Session completed. Payout is ready for withdrawal.',
    });
  } catch (error) {
    next(error);
  }
};

// 5. Razorpay Server Webhook Safety Net
exports.razorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const razorpaySignature = req.headers['x-razorpay-signature'];

    if (!razorpaySignature) {
      return res.status(400).send('No signature provided');
    }

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody)
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      return res.status(400).send('Invalid signature');
    }

    if (req.body.event === 'payment.captured' || req.body.event === 'order.paid') {
      const orderId = req.body.payload.payment.entity.order_id;
      const paymentId = req.body.payload.payment.entity.id;

      const callRequest = await CallRequest.findOne({ razorpayOrderId: orderId });
      if (callRequest && callRequest.paymentStatus !== 'paid') {
        callRequest.paymentStatus = 'paid';
        callRequest.razorpayPaymentId = paymentId;
        callRequest.status = 'accepted';
        callRequest.expiresAt = undefined;
        ensureBookingVideoSession(callRequest);
        await callRequest.save();
      }
    }

    res.status(200).send('Webhook processed');
  } catch (error) {
    console.error('Razorpay Webhook Error:', error);
    res.status(500).send('Webhook failed');
  }
};

// 6. Request Batch Payout (Expert Withdrawal)
exports.requestPayout = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const expertId = req.user._id;
    const { upiId, email, phoneNumber } = req.body;

    if (!upiId || !email || !phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'UPI ID, Email, and Phone Number are required to process the payout.',
      });
    }

    session.startTransaction();

    const existingPayout = await Payout.findOne({
      expert: expertId,
      payoutType: 'earning',
      status: { $in: ['pending', 'processing'] },
    }).session(session);

    if (existingPayout) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error:
          'You already have a withdrawal processing. Please wait for it to be completed before requesting another.',
      });
    }

    const totalRequestsReceived = await CallRequest.countDocuments({
      recipient: expertId,
    }).session(session);

    const totalRequestsSent = await CallRequest.countDocuments({
      requester: expertId,
    }).session(session);

    const totalCallsCompleted = await CallRequest.countDocuments({
      recipient: expertId,
      status: 'completed',
    }).session(session);

    const totalCallsRejected = await CallRequest.countDocuments({
      recipient: expertId,
      $or: [
        { status: { $in: ['rejected', 'cancelled'] } },
        { 'videoSession.status': 'expert_no_show' },
        { 'zoomMeeting.status': 'expert_no_show' },
      ],
    }).session(session);

    const readySessions = await CallRequest.find({
      recipient: expertId,
      status: 'completed',
      paymentStatus: { $in: ['paid', 'payout_ready'] },
    })
      .populate('requester', 'name email')
      .session(session);

    if (readySessions.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No new funds available for withdrawal.',
      });
    }

    let grossAmount = 0;
    const includedSessionIds = [];
    const detailedSessionsArray = [];

    readySessions.forEach((call) => {
      grossAmount += call.amount;
      includedSessionIds.push(call._id);
      detailedSessionsArray.push({
        sessionId: call._id,
        requesterId: call.requester ? call.requester._id : null,
        topic: call.topic || 'General Session',
        amountEarned: call.amount,
        date: call.scheduledAt || call.createdAt,
      });
    });

    const platformFee = Math.round(grossAmount * 0.1);
    const netPayable = grossAmount - platformFee;

    const payoutRequest = new Payout({
      expert: expertId,
      payoutType: 'earning',
      upiId: upiId.trim(),
      email: email.trim().toLowerCase(),
      phoneNumber: phoneNumber.trim(),
      financials: {
        grossAmount,
        platformFee,
        netPayable,
      },
      stats: {
        totalCallsCompleted,
        totalCallsRejected,
        totalRequestsReceived,
        totalRequestsSent,
      },
      includedSessions: detailedSessionsArray,
      status: 'pending',
    });

    await payoutRequest.save({ session });

    const lockResult = await CallRequest.updateMany(
      {
        _id: { $in: includedSessionIds },
        paymentStatus: { $in: ['paid', 'payout_ready'] },
      },
      { $set: { paymentStatus: 'payout_processing' } },
      { session }
    );

    if (lockResult.modifiedCount !== includedSessionIds.length) {
      throw new Error('Payout session locking failed. Transaction will be rolled back.');
    }

    await session.commitTransaction();

    return res.status(201).json({
      success: true,
      message: `Withdrawal of ₹${netPayable} requested successfully.`,
      data: payoutRequest,
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error:
          'You already have a withdrawal processing. Please wait for it to be completed before requesting another.',
      });
    }
    console.error('Payout Request Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to process payout request.',
    });
  } finally {
    await session.endSession();
  }
};

// 7. Get Student Refund Wallet Balance
exports.getRefundStats = async (req, res) => {
  try {
    const userId = req.user._id;

    const refundableSessions = await CallRequest.find({
      requester: userId,
      paymentStatus: { $in: ['paid', 'failed'] },$or: [
        { status: { $in: ['cancelled', 'rejected'] } },
        { 'videoSession.status': 'expert_no_show' },
        { 'zoomMeeting.status': 'expert_no_show' },
      ],
    });

    const refundableAmount = refundableSessions.reduce(
      (sum, sessionItem) => sum + (sessionItem.amount || 0),
      0
    );

    res.status(200).json({
      success: true,
      data: { refundableAmount, cancelledCount: refundableSessions.length },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch refund stats' });
  }
};

// 8. Request Student Refund Payout
exports.requestRefundPayout = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const userId = req.user._id;
    const { upiId, email, phoneNumber } = req.body;

    if (!upiId || !email || !phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'UPI ID, Email, and Phone Number are required to process the refund.',
      });
    }

    session.startTransaction();

    const existingRefund = await Payout.findOne({
      expert: userId,
      payoutType: 'refund',
      status: { $in: ['pending', 'processing'] },
    }).session(session);

    if (existingRefund) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'You already have a refund processing.',
      });
    }

    const readySessions = await CallRequest.find({
      requester: userId,
      paymentStatus: { $in: ['paid', 'failed'] },$or: [
        { status: { $in: ['cancelled', 'rejected'] } },
        { 'videoSession.status': 'expert_no_show' },
        { 'zoomMeeting.status': 'expert_no_show' },
      ],
    })
      .populate('recipient', 'name email')
      .session(session);

    if (readySessions.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No refundable sessions found.',
      });
    }

    let grossAmount = 0;
    const includedSessionIds = [];
    const detailedSessionsArray = [];

    readySessions.forEach((sessionItem) => {
      grossAmount += sessionItem.amount;
      includedSessionIds.push(sessionItem._id);
      detailedSessionsArray.push({
        sessionId: sessionItem._id,
        requesterId: sessionItem.recipient ? sessionItem.recipient._id : null,
        topic: 'Refund: ' + (sessionItem.topic || 'Cancelled Session'),
        amountEarned: sessionItem.amount,
        date: sessionItem.scheduledAt || sessionItem.createdAt,
      });
    });

    const payoutRequest = new Payout({
      expert: userId,
      payoutType: 'refund',
      upiId: upiId.trim(),
      email: email.trim().toLowerCase(),
      phoneNumber: phoneNumber.trim(),
      financials: {
        grossAmount,
        platformFee: 0,
        netPayable: grossAmount,
      },
      stats: {
        totalCallsCompleted: 0,
        totalCallsRejected: readySessions.length,
        totalRequestsReceived: 0,
        totalRequestsSent: 0,
      },
      includedSessions: detailedSessionsArray,
      status: 'pending',
    });

    await payoutRequest.save({ session });

    const lockResult = await CallRequest.updateMany(
      {
        _id: { $in: includedSessionIds },
        paymentStatus: { $in: ['paid', 'failed'] },$or: [
          { status: { $in: ['cancelled', 'rejected'] } },
          { 'videoSession.status': 'expert_no_show' },
          { 'zoomMeeting.status': 'expert_no_show' },
        ],
      },
      { $set: { paymentStatus: 'refund_processing' } },
      { session }
    );

    if (lockResult.modifiedCount !== includedSessionIds.length) {
      throw new Error('Refund session locking failed. Transaction will be rolled back.');
    }

    await session.commitTransaction();

    return res.status(201).json({
      success: true,
      message: `Refund of ₹${grossAmount} requested successfully.`,
    });
  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        error: 'You already have a refund processing.',
      });
    }
    console.error('Refund Request Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to process refund.',
    });
  } finally {
    await session.endSession();
  }
};