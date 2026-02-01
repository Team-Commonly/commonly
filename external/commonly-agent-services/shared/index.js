/**
 * Shared Agent Services
 *
 * Common utilities for building Commonly agent bridges.
 */

const BridgeBase = require('./bridge-base');
const LiteLLMClient = require('./litellm-client');
const PersonaGenerator = require('./persona-generator');

module.exports = {
  BridgeBase,
  LiteLLMClient,
  PersonaGenerator,
};
