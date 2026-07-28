/**
 * Retired Vercel handler.
 *
 * Voice processing now lives in the Node service at POST /api/voice and uses
 * the configured OpenRouter and Fish Audio providers. This file intentionally
 * performs no provider call so old Vercel deployments cannot silently use
 * Gemini with an unmanaged key.
 */
module.exports = async function handler(_req, res) {
  return res.status(410).json({
    error: 'This serverless endpoint was retired. Deploy the Node backend and use POST /api/voice.',
  });
};
