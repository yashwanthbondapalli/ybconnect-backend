// backend/server.js
require('dotenv').config();

if (!process.env.JWT_SECRET) {
  console.error('⛔ FATAL ERROR: JWT_SECRET environment variable is missing.');
  console.error('Shutting down the server to prevent security vulnerabilities...');
  process.exit(1);
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const connectDB = require('./src/config/db');
const errorHandler = require('./src/middlewares/errorHandler');

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
app.use(helmet());

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 250,
  message: {
    success: false,
    error: 'Too many requests from this IP, please try again later.',
  },
});
app.use('/api/', apiLimiter);

app.use(cors({ origin: '*' }));

// Parse JSON and preserve rawBody for Razorpay, LiveKit, and legacy Zoom webhooks
app.use(
  express.json({
    type: ['application/json', 'application/webhook+json'],
    verify: (req, res, buf) => {
      if (
        req.originalUrl === '/api/v1/livekit/webhook' ||
        req.originalUrl === '/api/v1/payments/webhook' ||
        req.originalUrl === '/api/v1/zoom/webhook'
      ) {
        req.rawBody = buf.toString();
      }
    },
  })
);

app.use(express.urlencoded({ extended: true }));

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
app.use('/api/v1/livekit', livekitRoutes);
app.use('/api/v1/zoom', zoomRoutes);
app.use('/api/v1/profile-reports', profileReportRoutes);

// Global Error Handler (Mounted AFTER all routes)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});