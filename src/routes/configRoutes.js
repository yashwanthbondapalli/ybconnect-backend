const express = require('express');
const router = express.Router();

// GET /api/config/version
// This tells the mobile app what the latest Play Store version is!
router.get('/version', (req, res) => {
  res.status(200).json({
    success: true,
    latestVersion: "1.0.7", // 🚨 Change this number whenever you upload a new .aab to the Play Store
    forceUpdate: false      // Keep this as an option for the future
  });
});

module.exports = router;