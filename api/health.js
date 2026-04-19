/**
 * api/health.js — Health check endpoint
 * GET /api/health
 */
module.exports = function handler(req, res) {
  res.status(200).json({
    status: 'ok',
    service: 'SalesAgent AI Voice',
    timestamp: new Date().toISOString(),
    anthropic: !!process.env.ANTHROPIC_API_KEY,
  });
};
