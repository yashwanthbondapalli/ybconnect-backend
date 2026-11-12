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

// Supports all valid UPI handles including alphanumeric bank suffixes (e.g., @ybl, @okaxis, @kotak811)
const UPI_REGEX = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z0-9.\-_]{2,32}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_REGEX = /^[0-9+\-\s]{10,16}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NUM_REGEX = /^[0-9]{9,18}$/;

// Timing-safe HMAC comparison to prevent timing attacks
const safeCompareHex = (expectedHex, receivedHex) => {
  if (typeof expectedHex !== 'string' || typeof receivedHex !== 'string') {
    return false;
  }
  const bufA = Buffer.from(expectedHex, 'utf8');
  const bufB = Buffer.from(receivedHex, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

// Safely extracts { upiId, email, phoneNumber } whether sent flat or nested by Redux slices
const extractPayoutContactDetails = (req) => {
  const rawBody = req.body || {};
  const nested =
    rawBody.upiId && typeof rawBody.upiId === 'object' ? rawBody.upiId : rawBody;

  const cleanUpi =
    typeof nested.upiId === 'string'
      ? nested.upiId.trim().toLowerCase()
      : typeof rawBody.upiId === 'string'
      ? rawBody.upiId.trim().toLowerCase()
      : '';

  const cleanEmail = (
    typeof nested.email === 'string' && nested.email.trim()
      ? nested.email.trim()
      : req.user?.email || ''
  ).toLowerCase();

  const rawPhone =
    typeof nested.phoneNumber === 'string' && nested.phoneNumber.trim()
      ? nested.phoneNumber.trim()
      : req.user?.phoneNumber || '9999999999';
  const cleanPhone = rawPhone.replace(/\s+/g, '');

  return { cleanUpi, cleanEmail, cleanPhone };
};

// ============================================================================
// 1. CREATE RAZORPAY ORDER & PROVISION IN-APP LIVEKIT VIDEO ROOM
// ============================================================================
exports.createOrder = async (req, res) => {
  try {
    const { requestId } = req.body;
    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, error: 'Valid requestId is required.' });
    }

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

    if (['paid', 'payout_ready', 'payout_processing'].includes(callRequest.paymentStatus)) {
      return res.status(400).json({ success: false, error: 'This session is already paid for.' });
    }

    // Student can ONLY pay AFTER the Mentor accepts the booking request
    if (callRequest.status !== 'accepted') {
      return res.status(400).json({
        success: false,
        error: 'Please wait for the mentor to accept your booking request before making payment.',
      });
    }

    if (!callRequest.amount || callRequest.amount <= 0 || isNaN(callRequest.amount)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid session amount.',
      });
    }

    const expertProfile = await Profile.findOne({ user: callRequest.recipient });
    if (!expertProfile) {
      return res.status(400).json({
        success: false,
        error: 'Expert profile not found.',
      });
    }

    // Lock in LiveKit room markers before creating Razorpay order
    ensureBookingVideoSession(callRequest);

    const totalAmountPaise = Math.round(Number(callRequest.amount) * 100);
    const options = {
      amount: totalAmountPaise,
      currency: 'INR',
      receipt: `receipt_req_${requestId}`,
    };

    const order = await razorpay.orders.create(options);

    callRequest.razorpayOrderId = order.id;
    await callRequest.save();

    return res.status(200).json({
      success: true,
      order,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('Order Creation Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to create payment order.' });
  }
};

// ============================================================================
// 2. VERIFY RAZORPAY PAYMENT SIGNATURE & CONFIRM BOOKING
// ============================================================================
exports.verifyPayment = async (req, res, next) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      requestId,
    } = req.body;

    if (
      typeof razorpay_order_id !== 'string' ||
      typeof razorpay_payment_id !== 'string' ||
      typeof razorpay_signature !== 'string' ||
      !requestId ||
      !mongoose.Types.ObjectId.isValid(requestId)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid payment verification parameters.',
      });
    }

    const callRequest = await CallRequest.findById(requestId);
    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    // IDOR Protection: Only the requester can verify payment
    if (callRequest.requester.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        error: 'You are not authorized to verify this payment.',
      });
    }

    if (!callRequest.razorpayOrderId || callRequest.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({
        success: false,
        error: 'Order ID mismatch. Payment verification failed.',
      });
    }

    // Native collection lookup prevents Mongoose CastError on `_id: { $ne: ... }`
    const duplicatePayment = await CallRequest.collection.findOne({
      razorpayPaymentId: razorpay_payment_id.trim(),
      _id: { $ne: new mongoose.Types.ObjectId(String(callRequest._id)) },
    });
    if (duplicatePayment) {
      return res.status(400).json({
        success: false,
        error: 'Security Alert: This payment ID has already been processed.',
      });
    }

    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (!safeCompareHex(expectedSignature, razorpay_signature)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Signature. Payment Fraud Detected.',
      });
    }

    // Idempotent check if Razorpay webhook already marked it paid
    if (callRequest.paymentStatus === 'paid') {
      return res.status(200).json({
        success: true,
        message: 'Payment already verified and video session confirmed!',
      });
    }

    callRequest.paymentStatus = 'paid';
    callRequest.razorpayPaymentId = razorpay_payment_id.trim();
    callRequest.status = 'accepted';
    callRequest.expiresAt = undefined;
    ensureBookingVideoSession(callRequest);

    await callRequest.save();

    const populatedRequest = await CallRequest.findById(requestId)
      .populate('requester', 'name email')
      .populate('recipient', 'name email');

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

      const expertMessage = `Hello ${populatedRequest.recipient.name},\n\nGreat news! ${populatedRequest.requester.name} has completed the payment of ₹${populatedRequest.amount} for your ${durationMins}-minute 1:1 session.\n\nSession Topic: ${populatedRequest.topic}\nScheduled Time: ${formattedISTTime} (IST)\n\n🎥 Your in-app video room will unlock 5 minutes before the session starts inside the YB Connect app (Bookings tab).\n\nThank you for mentoring on YB Connect!`;

      const studentMessage = `Hi ${populatedRequest.requester.name},\n\nPayment Successful! Your ${durationMins}-minute 1:1 session is confirmed.\n\nReceipt Details:\n- Amount Paid: ₹${populatedRequest.amount}\n- Mentor: ${populatedRequest.recipient.name}\n- Duration: ${durationMins} Minutes\n- Session Time: ${formattedISTTime} (IST)\n- Transaction ID: ${razorpay_payment_id}\n\n🎥 Your in-app video call button will unlock 5 minutes before the session starts inside the YB Connect app (Bookings tab).\n\nThank you for using YB Connect!`;

      await Promise.all([
        sendEmail({
          email: populatedRequest.recipient.email,
          subject: '💰 Booking Confirmed - Payment Received!',
          message: expertMessage,
        }),
        sendEmail({
          email: populatedRequest.requester.email,
          subject: '🧾 Booking Confirmed & Payment Receipt',
          message: studentMessage,
        }),
        sendPushNotification(
          populatedRequest.recipient._id,
          '💰 Payment Received! Session Confirmed 🎉',
          `${populatedRequest.requester.name} paid ₹${populatedRequest.amount} for your ${durationMins}m session on ${formattedISTTime}.`
        ),
      ]);
    } catch (emailErr) {
      console.error('Notification error after successful payment:', emailErr.message);
    }

    return res.status(200).json({
      success: true,
      message: 'Payment verified and video session confirmed!',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// 3. SAVE BANK DETAILS FOR MANUAL PAYOUT
// ============================================================================
exports.createLinkedAccount = async (req, res) => {
  try {
    const cleanAcc =
      typeof req.body?.accountNumber === 'string' ? req.body.accountNumber.trim() : '';
    const cleanIfsc =
      typeof req.body?.ifscCode === 'string'
        ? req.body.ifscCode.trim().toUpperCase()
        : '';

    if (!ACCOUNT_NUM_REGEX.test(cleanAcc)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid bank account number (9 to 18 digits).',
      });
    }

    if (!IFSC_REGEX.test(cleanIfsc)) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a valid 11-character IFSC code.',
      });
    }

    const updatedProfile = await Profile.findOneAndUpdate(
      { user: req.user._id },
      {
        accountNumber: cleanAcc,
        ifscCode: cleanIfsc,
        isPayoutActive: true,
        razorpayAccountId: 'manual_payout_mode',
      },
      { returnDocument: 'after' }
    );

    if (!updatedProfile) {
      return res.status(404).json({ success: false, error: 'Profile not found.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Bank account linked securely for payouts!',
      accountId: 'manual_payout_mode',
    });
  } catch (error) {
    console.error('Bank Save Error:', error);
    return res.status(500).json({ success: false, error: 'Failed to vault bank details.' });
  }
};

// ============================================================================
// 4. RELEASE ESCROW (RESTRICTED TO ADMIN OR PAYING STUDENT ONLY)
// ============================================================================
exports.releaseEscrow = async (req, res, next) => {
  try {
    const { requestId } = req.body;
    if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
      return res.status(400).json({ success: false, error: 'Valid requestId is required.' });
    }

    const callRequest = await CallRequest.findById(requestId);
    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }

    const userIdStr = req.user._id.toString();
    const isAdmin = req.user.role === 'admin';
    const isPayingStudent = callRequest.requester.toString() === userIdStr;

    // Mentors cannot manually release escrow to themselves
    if (!isAdmin && !isPayingStudent) {
      return res.status(403).json({
        success: false,
        error: 'Security Alert: Only an administrator or the paying student can manually release escrow.',
      });
    }

    if (callRequest.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Session must be completed first.' });
    }

    if (!callRequest.razorpayPaymentId) {
      return res.status(400).json({
        success: false,
        error: 'Cannot release escrow for an unpaid session.',
      });
    }

    callRequest.paymentStatus = 'payout_ready';
    await callRequest.save();

    return res.status(200).json({
      success: true,
      message: 'Escrow released. Payout is ready for withdrawal.',
    });
  } catch (error) {
    next(error);
  }
};

// ============================================================================
// 5. RAZORPAY SERVER WEBHOOK SAFETY NET
// ============================================================================
exports.razorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const razorpaySignature = req.headers['x-razorpay-signature'];

    if (!webhookSecret || !razorpaySignature || !req.rawBody) {
      return res.status(400).send('Missing webhook signature or payload');
    }

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody)
      .digest('hex');

    if (!safeCompareHex(expectedSignature, razorpaySignature)) {
      return res.status(400).send('Invalid signature');
    }

    if (req.body.event === 'payment.captured' || req.body.event === 'order.paid') {
      const paymentEntity = req.body?.payload?.payment?.entity;
      const orderId = paymentEntity?.order_id;
      const paymentId = paymentEntity?.id;

      if (orderId && paymentId) {
        const callRequest = await CallRequest.findOne({ razorpayOrderId: orderId });
        if (callRequest && callRequest.paymentStatus === 'pending') {
          callRequest.paymentStatus = 'paid';
          callRequest.razorpayPaymentId = paymentId;
          callRequest.status = 'accepted';
          callRequest.expiresAt = undefined;
          ensureBookingVideoSession(callRequest);
          await callRequest.save();
        }
      }
    }

    return res.status(200).send('Webhook processed');
  } catch (error) {
    console.error('Razorpay Webhook Error:', error);
    return res.status(500).send('Webhook failed');
  }
};

// ============================================================================
// 6. REQUEST BATCH PAYOUT (MENTOR EARNINGS WITHDRAWAL)
// ============================================================================
exports.requestPayout = async (req, res) => {
  const { cleanUpi, cleanEmail, cleanPhone } = extractPayoutContactDetails(req);

  if (!UPI_REGEX.test(cleanUpi)) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid UPI ID (e.g. yourname@ybl or 9876543210@okaxis).',
    });
  }
  if (!EMAIL_REGEX.test(cleanEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid contact email.',
    });
  }
  if (!PHONE_REGEX.test(cleanPhone)) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid 10-digit mobile number.',
    });
  }

  const session = await mongoose.startSession();

  try {
    const expertId = new mongoose.Types.ObjectId(String(req.user._id));
    session.startTransaction();

    const existingPayout = await Payout.collection.findOne(
      {
        expert: expertId,
        payoutType: 'earning',
        status: { $in: ['pending', 'processing'] },
      },
      { session }
    );

    if (existingPayout) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error:
          'You already have a withdrawal processing. Please wait for it to be completed before requesting another.',
      });
    }

    // Fetch completed paid/payout_ready sessions for this mentor
    const candidateSessions = await CallRequest.collection
      .find(
        {
          recipient: expertId,
          status: 'completed',
          paymentStatus: { $in: ['paid', 'payout_ready'] },
        },
        { session }
      )
      .toArray();

    // Filter out any session without payment proof or marked as expert_no_show
    const readySessions = candidateSessions.filter((call) => {
      const hasValidPayment =
        Boolean(call.razorpayPaymentId) || call.paymentStatus === 'payout_ready';
      const isNotNoShow =
        call.videoSession?.status !== 'expert_no_show' &&
        call.zoomMeeting?.status !== 'expert_no_show';
      return hasValidPayment && isNotNoShow;
    });

    if (readySessions.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No verified completed sessions are available for withdrawal.',
      });
    }

    let grossAmount = 0;
    const includedSessionIds = [];
    const detailedSessionsArray = [];

    readySessions.forEach((call) => {
      const callAmt = Math.max(0, Number(call.amount) || 0);
      if (callAmt > 0) {
        grossAmount += callAmt;
        includedSessionIds.push(call._id);
        detailedSessionsArray.push({
          sessionId: call._id,
          requesterId: call.requester || null,
          topic: call.topic || '1:1 Mentorship Session',
          amountEarned: callAmt,
          date: call.scheduledAt || call.createdAt,
        });
      }
    });

    const platformFee = Math.round(grossAmount * 0.1);
    const netPayable = grossAmount - platformFee;

    if (netPayable <= 0 || includedSessionIds.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No payable balance available for withdrawal.',
      });
    }

    const [totalRequestsReceived, totalRequestsSent, totalCallsCompleted, totalCallsRejected] =
      await Promise.all([
        CallRequest.collection.countDocuments({ recipient: expertId }, { session }),
        CallRequest.collection.countDocuments({ requester: expertId }, { session }),
        CallRequest.collection.countDocuments(
          {
            recipient: expertId,
            status: 'completed',
          },
          { session }
        ),
        CallRequest.collection.countDocuments(
          {
            recipient: expertId,
            $or: [
              { status: { $in: ['rejected', 'cancelled'] } },
              { 'videoSession.status': 'expert_no_show' },
            ],
          },
          { session }
        ),
      ]);

    const payoutRequest = new Payout({
      expert: expertId,
      payoutType: 'earning',
      upiId: cleanUpi,
      email: cleanEmail,
      phoneNumber: cleanPhone,
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

    const lockResult = await CallRequest.collection.updateMany(
      {
        _id: { $in: includedSessionIds },
        recipient: expertId,
        paymentStatus: { $in: ['paid', 'payout_ready'] },
      },
      { $set: { paymentStatus: 'payout_processing' } },
      { session }
    );

    if (lockResult.modifiedCount !== includedSessionIds.length) {
      throw new Error('Concurrent payout lock conflict detected. Rolling back.');
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
        error: 'You already have a withdrawal processing.',
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

// ============================================================================
// 7. GET STUDENT REFUND WALLET BALANCE (STRICTLY PAID SESSIONS ONLY)
// ============================================================================
exports.getRefundStats = async (req, res) => {
  try {
    const userId = new mongoose.Types.ObjectId(String(req.user._id));

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
      (sum, sessionItem) => sum + Math.max(0, Number(sessionItem.amount) || 0),
      0
    );

    return res.status(200).json({
      success: true,
      data: { refundableAmount, cancelledCount: refundableSessions.length },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: 'Failed to fetch refund stats' });
  }
};

// ============================================================================
// 8. REQUEST STUDENT REFUND PAYOUT (STRICTLY PAID SESSIONS ONLY)
// ============================================================================
exports.requestRefundPayout = async (req, res) => {
  const { cleanUpi, cleanEmail, cleanPhone } = extractPayoutContactDetails(req);

  if (!UPI_REGEX.test(cleanUpi)) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid UPI ID (e.g. 9876543210@ybl).',
    });
  }
  if (!EMAIL_REGEX.test(cleanEmail)) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid contact email.',
    });
  }
  if (!PHONE_REGEX.test(cleanPhone)) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid 10-digit mobile number.',
    });
  }

  const session = await mongoose.startSession();

  try {
    const userId = new mongoose.Types.ObjectId(String(req.user._id));
    session.startTransaction();

    const existingRefund = await Payout.collection.findOne(
      {
        expert: userId,
        payoutType: 'refund',
        status: { $in: ['pending', 'processing'] },
      },
      { session }
    );

    if (existingRefund) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'You already have a refund processing.',
      });
    }

    const readySessions = await CallRequest.collection
      .find(
        {
          requester: userId,
          razorpayPaymentId: { $exists: true, $nin: [null, ''] },
          paymentStatus: { $in: ['paid', 'failed'] },
          $or: [
            { status: { $in: ['cancelled', 'rejected'] } },
            { 'videoSession.status': 'expert_no_show' },
            { 'zoomMeeting.status': 'expert_no_show' },
          ],
        },
        { session }
      )
      .toArray();

    if (readySessions.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No refundable paid sessions found.',
      });
    }

    let grossAmount = 0;
    const includedSessionIds = [];
    const detailedSessionsArray = [];

    readySessions.forEach((sessionItem) => {
      const amt = Math.max(0, Number(sessionItem.amount) || 0);
      if (amt > 0) {
        grossAmount += amt;
        includedSessionIds.push(sessionItem._id);
        detailedSessionsArray.push({
          sessionId: sessionItem._id,
          requesterId: sessionItem.recipient || null,
          topic: 'Refund: ' + (sessionItem.topic || 'Cancelled Session'),
          amountEarned: amt,
          date: sessionItem.scheduledAt || sessionItem.createdAt,
        });
      }
    });

    if (grossAmount <= 0 || includedSessionIds.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No refundable balance available.',
      });
    }

    const payoutRequest = new Payout({
      expert: userId,
      payoutType: 'refund',
      upiId: cleanUpi,
      email: cleanEmail,
      phoneNumber: cleanPhone,
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

    const lockResult = await CallRequest.collection.updateMany(
      {
        _id: { $in: includedSessionIds },
        requester: userId,
        razorpayPaymentId: { $exists: true, $nin: [null, ''] },
        paymentStatus: { $in: ['paid', 'failed'] },
      },
      { $set: { paymentStatus: 'refund_processing' } },
      { session }
    );

    if (lockResult.modifiedCount !== includedSessionIds.length) {
      throw new Error('Refund session locking failed. Rolling back.');
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