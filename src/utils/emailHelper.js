// src/utils/emailHelper.js

const sendEmail = async (options) => {
  // 1. Grab the API key from Render's environment
  const apiKey = process.env.BREVO_API_KEY;

  if (!apiKey) {
    console.error("🚨 CRITICAL: BREVO_API_KEY is missing from Render environment!");
    throw new Error('Email configuration error');
  }

  // 2. Build the Brevo API payload
  const payload = {
    sender: { 
      name: 'YB Connect', 
      email: 'noreply@ybconnect.in' // Your verified domain!
    },
    to: [
      { email: options.email || options.to }
    ],
    subject: options.subject,
    textContent: options.message || options.text,
  };

  // 3. Blast it through Render's open HTTPS port (443)
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": apiKey,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    // Brevo returns a messageId if successful
    if (response.ok && data.messageId) {
      console.log(`✅ SUCCESS: API Email blasted to ${payload.to[0].email} (ID: ${data.messageId})`);
      return true;
    } else {
      console.error(`❌ BREVO API REJECTED IT:`, data);
      throw new Error(data.message || 'Brevo API rejected the email');
    }

  } catch (error) {
    console.error('❌ ERROR: Could not send email. Details:', error.message);
    throw new Error('Email could not be sent');
  }
};

module.exports = sendEmail;