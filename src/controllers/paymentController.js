const Razorpay = require('razorpay');
const crypto = require('crypto');
const CallRequest = require('../models/CallRequest');
const Profile = require('../models/Profile'); 
const axios = require('axios');
const zoomHelper = require('../utils/zoomHelper'); // 🚨 NEW: Import the Zoom generator
const sendEmail = require('../utils/emailHelper');
const Payout = require('../models/Payout'); // 🚨 NEW
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
      return res.status(404).json({ success: false, error: 'Request not found' });
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

      // 🚨 2. CRITICAL FIX: GENERATE THE ZOOM MEETING IMMEDIATELY
      try {
        console.log("Generating Zoom Meeting for Request:", requestId);
        // Assuming a default 60-minute session. Adjust if you store duration in CallRequest.
        const durationMinutes = 60; 
        
        const zoomDetails = await zoomHelper.createZoomMeeting(
          callRequest.recipient, 
          callRequest.topic, 
          callRequest.scheduledAt, 
          durationMinutes
        );

        // Save the generated links directly into the database
        callRequest.zoomMeeting = {
          meetingId: zoomDetails.meetingId,
          startUrl: zoomDetails.startUrl,
          joinUrl: zoomDetails.joinUrl,
          status: 'waiting'
        };
        console.log("Zoom meeting successfully attached to request!");
      } catch (zoomErr) {
        // If Zoom fails, we STILL save the payment so the user doesn't lose money, 
        // but we log a critical error so the admin can manually intervene.
        console.error("🚨 CRITICAL: Zoom Generation Failed after Payment:", zoomErr.message);
      }

      // 3. Save EVERYTHING (Payment details + Zoom details)
      await callRequest.save();

      const populatedRequest = await CallRequest.findById(requestId)
        .populate('requester', 'name email')
        .populate('recipient', 'name email');

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
          })
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

    const expertProfile = await Profile.findOne({ user: expertId });
    
    // We look for 'manual_payout_mode' since you are doing the Startup Hustle routing
    if (!expertProfile || !expertProfile.isPayoutActive || !expertProfile.accountNumber) {
      return res.status(400).json({ 
        success: false, 
        error: 'You must link a bank account before requesting a payout.' 
      });
    }

    // 🚨 THE FIX: Find ALL completed sessions that are 'paid' or 'payout_ready'
    const readySessions = await CallRequest.find({
      recipient: expertId,
      status: 'completed',
      paymentStatus: { $in: ['paid', 'payout_ready'] } // Safely catches manual tests
    });

    if (readySessions.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'No new funds available for withdrawal.' 
      });
    }

    // Calculate the Math
    let grossAmount = 0;
    const includedSessionIds = [];

    readySessions.forEach(session => {
      grossAmount += session.amount;
      includedSessionIds.push(session._id);
    });

    const platformFee = grossAmount * 0.10; // 10% Cut
    const netPayable = grossAmount - platformFee;

    // Create the Payout Document
    const payoutRequest = await Payout.create({
      expert: expertId,
      grossAmount,
      platformFee,
      netPayable,
      bankDetailsSnapshot: {
        accountNumber: expertProfile.accountNumber,
        ifscCode: expertProfile.ifscCode
      },
      includedSessions: includedSessionIds
    });

    // CRITICAL: Lock the sessions so they can't be withdrawn twice!
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