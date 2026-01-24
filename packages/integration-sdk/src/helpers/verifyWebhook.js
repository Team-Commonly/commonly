// Generic verify-token helper for GET webhook challenges (e.g., WhatsApp hub.challenge)
const { ValidationError } = require('../errors');

/**
 * Handles a GET verification request.
 * @param {object} query - request query params
 * @param {string} expectedToken - server-side verify token
 * @returns {{status: number, body: string}}
 */
function handleVerifyToken(query, expectedToken) {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = query;
  if (mode !== 'subscribe' || !token || token !== expectedToken) {
    throw new ValidationError('Invalid verify token');
  }
  return { status: 200, body: challenge };
}

module.exports = { handleVerifyToken };
