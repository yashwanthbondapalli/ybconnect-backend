const Razorpay = require('razorpay');
const crypto = require('crypto');
const CallRequest = require('../models/CallRequest');
const Profile = require('../models/Profile'); 
const axios = require('axios');
const zoomHelper = require('../utils/zoomHelper'); // 🚨 NEW: Import the Zoom generator
const sendEmail = require('../utils/emailHelper');
const Payout = require('../models/Payout'); // 🚨 NEW
const sendPushNotification = require('../utils/pushHelper');
// Initialize Razorpay with the keys you put in your .env file
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// 1. Create an Order (Automated Split & Escrow)
exports.createOrder = async (req, res, next) => {
  try {
    const { requestId } = req.body;
    
    const callRequest = await CallRequest.findById(requestId);

    if (!callRequest) {
      return res.status(404).json({ success: false, error: 'Request not found' });
    }
    // 🚨 SECURITY PATCH: IDOR PROTECTION 
    // Ensure the person trying to pay is ACTUALLY the student who created the request!
    if (callRequest.requester.toString() !== req.user._id.toString()) {
      return res.status(403).json({ 
        success: false, 
        error: 'Security Alert: You are not authorized to pay for this session.' 
      });
    }
    if (callRequest.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, error: 'This session is already paid for.' });
    }

    // 🚨 NEW: Prevent NaN Server Crash
    if (!callRequest.amount || callRequest.amount <= 0 || isNaN(callRequest.amount)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid session amount. The expert needs to set a valid price.' 
      });
    }

    // Fetch the Expert's Profile to get their routing ID
    const expertProfile = await Profile.findOne({ user: callRequest.recipient });

    if (!expertProfile) {
      return res.status(400).json({ 
        success: false, 
        error: 'The expert has not set up their bank account to receive payments yet.' 
      });
    }
    // 🚨 STEP 1 FIX: THE ZOOM DISASTER PREVENTION
    // Block the payment entirely if the expert has disconnected their Zoom account!
// 🚨 FIX 1: THE ZOOM DISASTER PREVENTION (Upgraded)
    if (!expertProfile.zoomCredentials || expertProfile.zoomCredentials.isConnected !== true) {
      return res.status(400).json({ 
        success: false, 
        error: 'Payment Blocked: The expert is currently experiencing Zoom connection issues.' 
      });
    }

    // 🚨 NEW: THE PRE-FLIGHT ZOOM ALLOCATION
    // Try to secure the Zoom room BEFORE we ask the student for money!
    if (!callRequest.zoomMeeting || !callRequest.zoomMeeting.startUrl) {
      try {
        console.log(`🔒 Pre-flight Zoom Check: Generating room for request ${requestId} before opening Razorpay...`);
        const zoomDetails = await zoomHelper.createZoomMeeting(
          callRequest.recipient, 
          callRequest.topic, 
          callRequest.scheduledAt, 
          40 // 40 min duration
        );
        
        // Save it to the database immediately so it is locked in!
        callRequest.zoomMeeting = {
          meetingId: zoomDetails.meetingId,
          startUrl: zoomDetails.startUrl,
          joinUrl: zoomDetails.joinUrl,
          status: 'waiting'
        };
        await callRequest.save();
        console.log(`✅ Pre-flight Zoom secured! Safe to charge student.`);

      } catch (zoomErr) {
        console.error("🚨 Pre-flight Zoom Error:", zoomErr.message);
        return res.status(400).json({ 
          success: false, 
          error: 'Payment Blocked: The expert\'s Zoom token expired. We cannot take your money until they reconnect.' 
        });
      }
    }



    // Calculate the Math (Razorpay strictly uses Paise, so multiply by 100)
    const totalAmountPaise = Math.round(callRequest.amount * 100);
    
    // Example: You take a 10% platform fee. Expert gets 90%.
    const platformFeePercentage = 0.10; 
    const expertSharePaise = Math.round(callRequest.amount * (1 - platformFeePercentage) * 100);

    // Razorpay Options with the Route 'transfers' array
    const options = {
      amount: totalAmountPaise, 
      currency: "INR",
      receipt: `receipt_req_${requestId}`,

    };

    // Ask Razorpay to create the split order
    const order = await razorpay.orders.create(options);

    // Save this order ID to our database so we can track it
    callRequest.razorpayOrderId = order.id;
    await callRequest.save();

    res.status(200).json({ 
      success: true, 
      order, 
      key: process.env.RAZORPAY_KEY_ID 
    });
  } catch (error) {
    console.error("Order Creation Error:", error);
    res.status(500).json({ success: false, error: 'Failed to create payment order.' });
  }
};

// 2. Verify Payment (Runs strictly AFTER the user types their card info and pays)
exports.verifyPayment = async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, requestId } = req.body;

const callRequest = await CallRequest.findById(requestId);

if (!callRequest) {
  return res.status(404).json({
    success: false,
    error: 'Request not found'
  });
}

// SECURITY: Only the student/requester who created this
// CallRequest is allowed to verify its payment.
if (callRequest.requester.toString() !== req.user._id.toString()) {
  console.error(
    `🚨 UNAUTHORIZED PAYMENT VERIFICATION ATTEMPT: User ${req.user._id} tried to verify Request ${requestId}`
  );

  return res.status(403).json({
    success: false,
    error: 'You are not authorized to verify this payment.'
  });
}

if (callRequest.razorpayOrderId !== razorpay_order_id) {
      console.error(`🚨 FRAUD ALERT: Order ID mismatch for Request ${requestId}`);
      return res.status(400).json({ success: false, error: 'Order ID mismatch. Payment verification failed.' });
    }

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

if (expectedSignature === razorpay_signature) {
      // 1. Safe to update Payment Status
      callRequest.paymentStatus = 'paid';
      callRequest.razorpayPaymentId = razorpay_payment_id;

      // 🚨 NEW: THE AUTO-REFUND SAFETY NET
      // Since we use Pre-Flight Allocation, the link should ALREADY be here.
      // If it is somehow missing, we instantly push the money to the Refund Wallet!
      if (!callRequest.zoomMeeting || !callRequest.zoomMeeting.startUrl) {
        console.error("🚨 CRITICAL BUG: Money taken but no Zoom link exists! Triggering Auto-Refund...");
        
        callRequest.status = 'cancelled';
        callRequest.zoomMeeting = { status: 'expert_no_show' }; // Magically puts money in Refund Wallet
        await callRequest.save();

        const populatedRequest = await CallRequest.findById(requestId).populate('requester', 'name email').populate('recipient', 'name email');

        await sendEmail({
          email: populatedRequest.requester.email,
          subject: '⚠️ Error Generating Session Link - Refund Issued',
          message: `Hi ${populatedRequest.requester.name},\n\nYour payment of ₹${populatedRequest.amount} was successful, but the expert's Zoom account crashed before we could finalize the meeting link.\n\nTo protect your funds, we have instantly transferred this amount to your Refund Wallet. You can withdraw it immediately from your Appointments Dashboard.\n\nWe apologize for the inconvenience.`
        });
        
        return res.status(200).json({ success: true, message: 'Payment verified, but Zoom failed. Refund issued to wallet.' });
      }

      // 3. Save the final Paid status
      await callRequest.save();

      const populatedRequest = await CallRequest.findById(requestId)
        .populate('requester', 'name email')
        .populate('recipient', 'name email');

      // 4. Send Emails WITH THE EXACT IST TIME!
// 4. Send Emails WITH THE EXACT IST TIME!
      try {
        // 🚨 THE TIMEZONE FIX: Force the server to format in Indian Standard Time
        const formattedISTTime = new Date(populatedRequest.scheduledAt).toLocaleString('en-IN', {
          timeZone: 'Asia/Kolkata',
          weekday: 'short', 
          year: 'numeric', 
          month: 'short', 
          day: 'numeric', 
          hour: '2-digit', 
          minute: '2-digit',
          hour12: true
        });

        const expertMessage = `Hello ${populatedRequest.recipient.name},\n\nGreat news! ${populatedRequest.requester.name} has successfully paid ₹${populatedRequest.amount} for your upcoming session.\n\nYour session starts at: ${formattedISTTime} (IST).\n\n🎥 You will receive an automated email reminder with your Host Video Link 5 minutes before the session starts. You can also access it directly from your Appointments dashboard.\n\nThank you for choosing YB Connect!`;

        const studentMessage = `Hi ${populatedRequest.requester.name},\n\nPayment Successful! Your session is confirmed.\n\nHere are your receipt details:\n\n- Amount Paid: ₹${populatedRequest.amount}\n- Expert: ${populatedRequest.recipient.name}\n- Session Time: ${formattedISTTime} (IST)\n- Transaction ID: ${razorpay_payment_id}\n\n🎥 You will receive an automated email reminder with your Join Video Link 5 minutes before the session starts. You can also access it directly from your Appointments dashboard.\n\nThank you for using YB Connect!`;

        await Promise.all([
          sendEmail({
            email: populatedRequest.recipient.email,
            subject: '💰 Payment Received - Session Confirmed!',
            message: expertMessage
          }),
          sendEmail({
            email: populatedRequest.requester.email,
            subject: '🧾 Payment Receipt - Session Confirmed',
            message: studentMessage
          }),
     
        sendPushNotification(
            populatedRequest.recipient._id,
            "💰 Payment Received! 🎉",
            `${populatedRequest.requester.name} just paid ₹${populatedRequest.amount} for your session at ${formattedISTTime}.`
          )
        ]);

        console.log('📧 Both Payment & Receipt emails sent successfully (Waiting for Brevo reminder)!');
      } catch (emailErr) {
        console.error('Email failed to send, but payment & Zoom were successful:', emailErr);
      }
      res.status(200).json({ success: true, message: 'Payment verified and Zoom generated successfully' });
    } else {
      res.status(400).json({ success: false, error: 'Invalid Signature. Payment Fraud Detected.' });
    }
  } catch (error) {
    next(error);
  }
};

// 🚨 NEW SAFETY CHECK: Ensure keys exist before hitting Razorpay
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error("⛔ FATAL ERROR: Razorpay API keys are missing from your .env file!");
}

// 3. Create a Linked Account for the Expert (Payout Onboarding)
// 3. Save Bank Details for Admin Manual Payout (Startup Hustle Plan)
exports.createLinkedAccount = async (req, res, next) => {
  try {
    const { name, email, accountNumber, ifscCode } = req.body;
    const userId = req.user._id; 

    // 🚨 STARTUP HUSTLE PLAN: Skip Razorpay's Route API.
    // We are simply saving the expert's bank details to our MongoDB.
    // This allows the Admin Dashboard to fetch them on Fridays for manual PhonePe transfers.

    const updatedProfile = await Profile.findOneAndUpdate(
      { user: userId }, 
      {
        accountNumber: accountNumber,
        ifscCode: ifscCode,
        isPayoutActive: true,
        razorpayAccountId: 'manual_payout_mode' // Dummy flag so the mobile app shows ✅ Bank Linked
      },
      { new: true }
    );

    if (!updatedProfile) {
      return res.status(404).json({ success: false, error: 'Profile not found.' });
    }

    res.status(200).json({ 
      success: true, 
      message: 'Bank account linked securely for payouts!',
      accountId: 'manual_payout_mode' 
    });

  } catch (error) {
    console.error("Bank Save Error:", error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to vault bank details.' 
    });
  }
};

// 4. Release Escrow (Runs when the Zoom call is successfully finished)
// 4. Release Escrow (Startup Hustle Version)
exports.releaseEscrow = async (req, res, next) => {
  try {
    const { requestId } = req.body;
    const callRequest = await CallRequest.findById(requestId);

    if (!callRequest) return res.status(404).json({ success: false, error: 'Request not found' });

    // Security Check
    const userIdStr = req.user._id.toString();
    if (callRequest.requester.toString() !== userIdStr && callRequest.recipient.toString() !== userIdStr) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    if (callRequest.status !== 'completed') {
      return res.status(400).json({ success: false, error: 'Session must be completed first.' });
    }

    // 🚨 STARTUP HUSTLE PLAN: Just update the database status!
    // We change the payment status from 'paid' to 'payout_ready'
    callRequest.paymentStatus = 'payout_ready'; 
    await callRequest.save();

    res.status(200).json({ 
      success: true, 
      message: 'Session completed. The platform admin will manually process the expert payout.' 
    });

  } catch (error) {
    next(error);
  }
};


// 5. THE RAZORPAY WEBHOOK (The Ultimate Safety Net)
exports.razorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const razorpaySignature = req.headers['x-razorpay-signature'];

    if (!razorpaySignature) {
      return res.status(400).send('No signature provided');
    }

    // 1. Verify the Signature (The Bouncer)
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody) // ✅ CRITICAL FIX: Use the exact raw string
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      console.log('🚨 RAZORPAY WEBHOOK BLOCKED: Invalid Signature');
      return res.status(400).send('Invalid signature');
    }

    console.log(`✅ RAZORPAY WEBHOOK RECEIVED: ${req.body.event}`);

    // 2. Handle the Successful Payment Event
    if (req.body.event === 'payment.captured' || req.body.event === 'order.paid') {
      
      // Razorpay hides the Order ID deep inside the payload
      const orderId = req.body.payload.payment.entity.order_id;
      const paymentId = req.body.payload.payment.entity.id;

      // Find the specific session attached to this payment
      const callRequest = await CallRequest.findOne({ razorpayOrderId: orderId });

      if (callRequest) {
        // If the frontend already updated this to 'paid', we don't need to do anything!
        if (callRequest.paymentStatus !== 'paid') {
          console.log(`🛡️ Webhook Safety Net Activated! Updating session ${callRequest._id} to paid.`);
          
          callRequest.paymentStatus = 'paid';
          callRequest.razorpayPaymentId = paymentId;
          await callRequest.save();

          // Optional: You can copy-paste your sendEmail logic here too 
          // if you want the webhook to also handle sending the receipts!
        } else {
          console.log(`ℹ️ Session ${callRequest._id} was already marked paid by the frontend.`);
        }
      }
    }

    // Always respond with 200 OK fast so Razorpay knows we got it
    res.status(200).send('Webhook processed');

  } catch (error) {
    console.error('Razorpay Webhook Error:', error);
    res.status(500).send('Webhook failed');
  }
};

// 🚨 Ensure you import the Payout model at the very top of paymentController.js:
// const Payout = require('../models/Payout');

// 6. Request Batch Payout (Expert clicks "Request Withdrawal")
exports.requestPayout = async (req, res, next) => {
  try {
    const expertId = req.user._id;
    
    // 🚨 1. EXTRACT NEW INPUTS FROM THE APP
    const { upiId, email, phoneNumber } = req.body;

    if (!upiId || !email || !phoneNumber) {
      return res.status(400).json({ 
        success: false, 
        error: 'UPI ID, Email, and Phone Number are required to process the payout.' 
      });
    }

    // 🚀 THE BULLETPROOF FIX: Check if they already have a payout processing!
    const existingPayout = await Payout.findOne({
      expert: expertId,
      payoutType: 'earning', // 🚨 ADD THIS LINE
      status: { $in: ['pending', 'processing'] }
    });

    if (existingPayout) {
      return res.status(400).json({ 
        success: false, 
        error: 'You already have a withdrawal processing. Please wait for it to be completed before requesting another.' 
      });
    }

    // 🚨 2. GATHER LIFETIME STATS (For the Immutable Receipt)
    const totalRequestsReceived = await CallRequest.countDocuments({ recipient: expertId });
    const totalRequestsSent = await CallRequest.countDocuments({ requester: expertId });
    const totalCallsCompleted = await CallRequest.countDocuments({ recipient: expertId, status: 'completed' });
    const totalCallsRejected = await CallRequest.countDocuments({ 
      recipient: expertId, 
      status: { $in: ['rejected', 'cancelled', 'expert_no_show'] } 
    });

    // 🚨 3. FIND ELIGIBLE SESSIONS
    // Find completed sessions that haven't been withdrawn yet.
    const readySessions = await CallRequest.find({
      recipient: expertId,
      status: 'completed',
      paymentStatus: { $in: ['paid', 'payout_ready'] } 
    }).populate('requester', 'name email'); // Populate so we can grab the user details!

    if (readySessions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No new funds available for withdrawal.' 
      });
    }

    // 🚨 4. CALCULATE MATH & BUILD DETAILED ARRAY
    let grossAmount = 0;
    const includedSessionIds = [];
    const detailedSessionsArray = [];

    readySessions.forEach(session => {
      grossAmount += session.amount;
      includedSessionIds.push(session._id);
      
      // Build the detailed receipt entry
      detailedSessionsArray.push({
        sessionId: session._id,
        requesterId: session.requester ? session.requester._id : null,
        topic: session.topic || 'General Session',
        amountEarned: session.amount,
        date: session.scheduledAt || session.createdAt
      });
    });

    const platformFee = Math.round(grossAmount * 0.10); // 10% Cut
    const netPayable = grossAmount - platformFee;

    // 🚨 5. CREATE THE IMMUTABLE PAYOUT RECEIPT
    const payoutRequest = await Payout.create({
      expert: expertId,
      payoutType: 'earning',
      upiId: upiId.trim(),
      email: email.trim().toLowerCase(),
      phoneNumber: phoneNumber.trim(),
      financials: {
        grossAmount,
        platformFee,
        netPayable
      },
      stats: {
        totalCallsCompleted,
        totalCallsRejected,
        totalRequestsReceived,
        totalRequestsSent
      },
      includedSessions: detailedSessionsArray,
      status: 'pending'
    });

    // 🚨 6. LOCK THE SESSIONS (So they can't withdraw them again)
    await CallRequest.updateMany(
      { _id: { $in: includedSessionIds } },
      { $set: { paymentStatus: 'payout_processing' } }
    );

    res.status(201).json({
      success: true,
      message: `Withdrawal of ₹${netPayable} requested successfully.`,
      data: payoutRequest
    });

  } catch (error) {
    console.error("Payout Request Error:", error);
    res.status(500).json({ success: false, error: 'Failed to process payout request.' });
  }
};

// ==========================================
// 🚨 NEW: THE REFUND WALLET LOGIC
// ==========================================

// A. Get Refund Balance
exports.getRefundStats = async (req, res, next) => {
  try {
    const userId = req.user._id;

    // Find sessions the user PAID for, but were cancelled/rejected or the expert no-showed
    const refundableSessions = await CallRequest.find({
      requester: userId,
      paymentStatus: { $in: ['paid', 'failed'] }, // Money is in our Escrow
      $or: [
        { status: { $in: ['cancelled', 'rejected'] } },
        { 'zoomMeeting.status': 'expert_no_show' }
      ]
    });

    const refundableAmount = refundableSessions.reduce((sum, session) => sum + session.amount, 0);

    res.status(200).json({
      success: true,
      data: { refundableAmount, cancelledCount: refundableSessions.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch refund stats' });
  }
};

// B. Request Refund Payout
exports.requestRefundPayout = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { upiId, email, phoneNumber } = req.body;

    const existingRefund = await Payout.findOne({
      expert: userId,
      payoutType: 'refund',
      status: { $in: ['pending', 'processing'] }
    });

    if (existingRefund) return res.status(400).json({ success: false, error: 'You already have a refund processing.' });

    const readySessions = await CallRequest.find({
      requester: userId,
      paymentStatus: { $in: ['paid', 'failed'] },
      $or: [{ status: { $in: ['cancelled', 'rejected'] } }, { 'zoomMeeting.status': 'expert_no_show' }]
    }).populate('recipient', 'name email');

    if (readySessions.length === 0) return res.status(400).json({ success: false, error: 'No refundable sessions found.' });

    let grossAmount = 0;
    const includedSessionIds = [];
    const detailedSessionsArray = [];

    readySessions.forEach(session => {
      grossAmount += session.amount;
      includedSessionIds.push(session._id);
      detailedSessionsArray.push({
        sessionId: session._id,
        requesterId: session.recipient._id, // Save expert ID for reference
        topic: 'Refund: ' + (session.topic || 'Cancelled Session'),
        amountEarned: session.amount,
        date: session.scheduledAt || session.createdAt
      });
    });

    // 🚨 100% REFUND (No Platform Fee Taken!)
    const payoutRequest = await Payout.create({
      expert: userId,
      payoutType: 'refund',
      upiId: upiId.trim(),
      email: email.trim().toLowerCase(),
      phoneNumber: phoneNumber.trim(),
      financials: { grossAmount, platformFee: 0, netPayable: grossAmount },
      stats: { totalCallsCompleted: 0, totalCallsRejected: readySessions.length, totalRequestsReceived: 0, totalRequestsSent: 0 },
      includedSessions: detailedSessionsArray,
      status: 'pending'
    });

    await CallRequest.updateMany({ _id: { $in: includedSessionIds } }, { $set: { paymentStatus: 'refund_processing' } });

    res.status(201).json({ success: true, message: `Refund of ₹${grossAmount} requested successfully.` });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to process refund.' });
  }
};