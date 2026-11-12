// backend/server.js
require('dotenv').config();

if (!process.env.JWT_SECRET || !process.env.REFRESH_TOKEN_SECRET) {
  console.error(
    '⛔ FATAL ERROR: JWT_SECRET or REFRESH_TOKEN_SECRET environment variable is missing.'
  );
  console.error('Shutting down the server to prevent security vulnerabilities...');
  process.exit(1);
}

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./src/config/db');
const errorHandler = require('./src/middlewares/errorHandler');

// Ensure Mongoose does not corrupt internal controller operators ($ne, $in, $gte)
mongoose.set('sanitizeFilter', false);

// Route Imports
const authRoutes = require('./src/routes/authRoutes');
const profileRoutes = require('./src/routes/profileRoutes');
const configRoutes = require('./src/routes/configRoutes');
const ideaRoutes = require('./src/routes/ideaRoutes');
const expertRoutes = require('./src/routes/expertRoutes');
const reviewerRoutes = require('./src/modules/resume-reviewer/routes/reviewer.routes');
const requestRoutes = require('./src/routes/requestRoutes');
const reportRoutes = require('./src/routes/reportRoutes');
const paymentRoutes = require('./src/routes/paymentRoutes');
const zoomRoutes = require('./src/routes/zoomRoutes');
const livekitRoutes = require('./src/routes/livekitRoutes');
const profileReportRoutes = require('./src/routes/profileReportRoutes');
const dashboardRoutes = require('./src/routes/dashboardRoutes');

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet());

// 🛡️ ANDROID APP LINKS VERIFICATION (/.well-known/assetlinks.json)
// Allows Google Play & Android 15/16 to verify https://ybconnect.in deep links
app.get('/.well-known/assetlinks.json', (req, res) => {
  const fingerprints = [
    process.env.ANDROID_SHA256_FINGERPRINT,
    process.env.ANDROID_UPLOAD_SHA256_FINGERPRINT,
  ].filter(Boolean);

  res.setHeader('Content-Type', 'application/json');
  res.status(200).json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'com.ybconnect.app',
        sha256_cert_fingerprints:
          fingerprints.length > 0
            ? fingerprints
            : [
                // AddANDROID_SHA256_FINGERPRINT in Render Environment Variables
                '00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00',
              ],
      },
    },
  ]);
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 250,
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);

app.use(cors({ origin: '*' }));

// Parse JSON with a strict 1MB limit and preserve rawBody for webhook HMAC verification
app.use(
  express.json({
    limit: '1mb',
    type: ['application/json', 'application/webhook+json'],
    verify: (req, res, buf) => {
      if (
        req.originalUrl.startsWith('/api/v1/livekit/webhook') ||
        req.originalUrl.startsWith('/api/v1/payments/webhook') ||
        req.originalUrl.startsWith('/api/v1/payment/webhook') ||
        req.originalUrl.startsWith('/api/v1/zoom/webhook')
      ) {
        req.rawBody = buf.toString('utf8');
      }
    },
  })
);

app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 🛡️ GLOBAL NOSQL INJECTION & PROTOTYPE POLLUTION SANITIZER
const sanitizeObjectInPlace = (obj) => {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (
      key.startsWith('$') ||
      key.includes('.') ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    ) {
      delete obj[key];
    } else if (typeof obj[key] === 'object') {
      sanitizeObjectInPlace(obj[key]);
    }
  }
};

app.use((req, res, next) => {
  sanitizeObjectInPlace(req.body);
  sanitizeObjectInPlace(req.query);
  sanitizeObjectInPlace(req.params);
  next();
});

// Database Connection & Background Cron Scheduler
connectDB();
require('./src/utils/scheduler.js');

// Health Check Route
app.use('/api/v1/health', (req, res) => {
  res.status(200).json({ success: true, message: 'BacktoBase API is operational.' });
});

// Mount API Routes
app.use('/api/v1', dashboardRoutes);
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/config', configRoutes);
app.use('/api/v1/ideas', ideaRoutes);
app.use('/api/v1/experts', expertRoutes);
app.use('/api/v1/resume-reviewer', reviewerRoutes);
app.use('/api/v1/requests', requestRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/payment', paymentRoutes); // Alias so both /payment and /payments work
app.use('/api/v1/livekit', livekitRoutes);
app.use('/api/v1/zoom', zoomRoutes);
app.use('/api/v1/profile-reports', profileReportRoutes);

// Global Error Handler (Mounted AFTER all routes)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});