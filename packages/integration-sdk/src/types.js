// Normalized message and summary shapes shared across providers.

/**
 * @typedef {Object} NormalizedAttachment
 * @property {'image'|'file'|'link'} type
 * @property {string} url
 * @property {string} [title]
 */

/**
 * @typedef {Object} NormalizedMessage
 * @property {string} source - e.g., 'discord', 'whatsapp', 'telegram'.
 * @property {string} externalId
 * @property {string} authorId
 * @property {string} authorName
 * @property {string} content
 * @property {string} timestamp - ISO string
 * @property {NormalizedAttachment[]} [attachments]
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} NormalizedSummaryInput
 * @property {NormalizedMessage[]} messages
 * @property {Object} context - { source, channelId/chatId, window: { start, end } }
 */

module.exports = {};
