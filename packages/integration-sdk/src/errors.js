class IntegrationError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.meta = meta;
  }
}

class ValidationError extends IntegrationError {
  constructor(message, meta = {}) {
    super(message, meta);
    this.name = 'ValidationError';
  }
}

module.exports = { IntegrationError, ValidationError };
