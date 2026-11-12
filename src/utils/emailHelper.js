// backend/src/utils/emailHelper.js
const sendEmail = async (options) => {
  const apiKey = process.env.BREVO_API_KEY;

  if (!apiKey) {
    console.error('🚨 CRITICAL: BREVO_API_KEY is missing from environment!');
    throw new Error('Email configuration error');
  }

  const recipientEmail = String(options?.email || options?.to || '')
    .trim()
    .toLowerCase();

  if (!recipientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(recipientEmail)) {
    throw new Error('Invalid recipient email address');
  }

  const cleanSubject = String(options?.subject || 'YB Connect Notification')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);

  const payload = {
    sender: {
      name: 'YB Connect',
      email: 'noreply@ybconnect.in',
    },
    to: [{ email: recipientEmail }],
    subject: cleanSubject,
    textContent: String(options?.message || options?.text || ''),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await response.json();

    if (response.ok && data.messageId) {
      return true;
    } else {
      console.error('❌ BREVO API REJECTED EMAIL:', data);
      throw new Error(data.message || 'Brevo API rejected the email');
    }
  } catch (error) {
    console.error('❌ Email Send Error:', error.message);
    throw new Error('Email could not be sent');
  } finally {
    clearTimeout(timeoutId);
  }
};

module.exports = sendEmail;