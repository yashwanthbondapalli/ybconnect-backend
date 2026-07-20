require('dotenv').config();

// --- ENTERPRISE FIX START (Issue 7) ---
// Pre-flight check: Ensure critical environment variables exist before booting
if (!process.env.JWT_SECRET) {
  console.error("⛔ FATAL ERROR: JWT_SECRET environment variable is missing.");
  console.error("Shutting down the server to prevent security vulnerabilities...");
  process.exit(1);
}
// --- ENTERPRISE FIX END ---

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const connectDB = require('./src/config/db');
const errorHandler = require('./src/middlewares/errorHandler');
const zoomRoutes = require('./src/routes/zoomRoutes'); // Adjust path if necessary
// 1. Import the route file at the top with your others
const dashboardRoutes = require('./src/routes/dashboardRoutes');

const reviewerRoutes = require('./src/modules/resume-reviewer/routes/reviewer.routes.js');



const app = express();
// 🚨 GLOBAL LIGHT SWITCH: Log every single request that hits the server
// 🚨 UPDATED GLOBAL LIGHT SWITCH: Log incoming request headers
app.use((req, res, next) => {
  //console.log(`➡️ INCOMING REQUEST: [${req.method}] ${req.url}`);
  //console.log(`📋 INCOMING HEADERS:`, JSON.stringify(req.headers));
  next();
});
// Trust the first proxy in front of Express
app.set('trust proxy', 1);
require('./cronJobs');
// Middleware
app.use(helmet());
// 2. Mount it to your main API path
app.use('/api/v1', dashboardRoutes);
app.use(cors({
  origin: '*', // Allows your mobile app and future web apps to connect freely
}));
app.use(express.json({
  verify: (req, res, buf) => {
// Only save raw body for the Zoom webhook route!
    if (req.originalUrl === '/api/v1/zoom/webhook' || req.originalUrl === '/api/v1/payments/webhook') {
      req.rawBody = buf.toString();
    }
  }
}));

app.use(express.urlencoded({ extended: true }));

// Database Connection
connectDB();
require('./src/utils/scheduler.js');

// Health Check Route
app.use('/api/v1/health', (req, res) => {
  res.status(200).json({ success: true, message: 'BacktoBase API is operational.' });
});

// Add this below your health check route
const authRoutes = require('./src/routes/authRoutes');
app.use('/api/v1/auth', authRoutes);

// Add to your existing routes in server.js
const profileRoutes = require('./src/routes/profileRoutes');
app.use('/api/v1/profile', profileRoutes);

const ideaRoutes = require('./src/routes/ideaRoutes.js')
app.use('/api/v1/ideas', ideaRoutes);

// Add to your existing routes in server.js
const expertRoutes = require('./src/routes/expertRoutes');
app.use('/api/v1/experts', expertRoutes);

// 2. Mount it to match the exact URL your frontend is hitting
app.use('/api/v1/resume-reviewer', reviewerRoutes);

const requestRoutes = require('./src/routes/requestRoutes');
app.use('/api/v1/requests', requestRoutes);

app.use('/api/v1/reports', require('./src/routes/reportRoutes'));

// Global Error Handler
app.use(errorHandler);

const paymentRoutes = require('./src/routes/paymentRoutes');
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/zoom', zoomRoutes);

const PORT = process.env.PORT || 5000;
// Adding '0.0.0.0' forces the server to accept connections from outside the laptop
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`);
});
