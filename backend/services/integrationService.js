const Integration = require('../models/Integration');

/**
 * Common Integration Service
 * Abstract base class for all platform integrations
 */
class IntegrationService {
  constructor(integrationId) {
    this.integrationId = integrationId;
    this.integration = null;
  }

  /**
   * Initialize the integration
   * @returns {Promise<boolean>}
   */
  static async initialize() {
    throw new Error('initialize() must be implemented by subclass');
  }

  /**
   * Connect to the platform
   * @returns {Promise<boolean>}
   */
  static async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from the platform
   * @returns {Promise<boolean>}
   */
  static async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Fetch recent messages from the platform
   * @param {Object} _options - Fetch options
   * @returns {Promise<Array>}
   */
  static async fetchMessages(_options = {}) {
    throw new Error('fetchMessages() must be implemented by subclass');
  }

  /**
   * Send a message to the platform
   * @param {string} message - Message content
   * @param {Object} _options - Send options
   * @returns {Promise<Object>}
   */
  static async sendMessage(message, _options = {}) {
    throw new Error('sendMessage() must be implemented by subclass');
  }

  /**
   * Get available channels/servers
   * @returns {Promise<Array>}
   */
  static async getChannels() {
    throw new Error('getChannels() must be implemented by subclass');
  }

  /**
   * Get connection status
   * @returns {Promise<string>}
   */
  static async getStatus() {
    throw new Error('getStatus() must be implemented by subclass');
  }

  /**
   * Test the connection
   * @returns {Promise<boolean>}
   */
  static async testConnection() {
    throw new Error('testConnection() must be implemented by subclass');
  }

  /**
   * Update integration status
   * @param {string} status - New status
   * @param {string} errorMessage - Optional error message
   */
  async updateStatus(status, errorMessage = null) {
    try {
      await Integration.findByIdAndUpdate(this.integrationId, {
        status,
        errorMessage,
        lastSync:
          status === 'connected' ? new Date() : this.integration?.lastSync,
      });

      // Update local reference
      if (this.integration) {
        this.integration.status = status;
        this.integration.errorMessage = errorMessage;
        if (status === 'connected') {
          this.integration.lastSync = new Date();
        }
      }
    } catch (error) {
      console.error('Error updating integration status:', error);
      throw error;
    }
  }

  /**
   * Validate integration configuration
   * @param {Object} _config - Configuration object
   * @returns {Promise<boolean>}
   */
  static async validateConfig(_config) {
    throw new Error('validateConfig() must be implemented by subclass');
  }

  /**
   * Get integration statistics
   * @returns {Promise<Object>}
   */
  static async getStats() {
    throw new Error('getStats() must be implemented by subclass');
  }

  /**
   * Handle webhook events
   * @param {Object} _event - Webhook event data
   * @returns {Promise<void>}
   */
  static async handleWebhook(_event) {
    throw new Error('handleWebhook() must be implemented by subclass');
  }
}

module.exports = IntegrationService;
