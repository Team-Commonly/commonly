import type { Express } from 'express';

const Sentry = require('@sentry/node') as typeof import('@sentry/node');
// A leaf module: this file loads first, so it may import nothing from the app.
const { keepScrubbedItems, scrubSentryEvent } = require('./services/serverErrorReport');

const sentryDsn = process.env.SENTRY_DSN;

if (sentryDsn) {
  const client = Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.NODE_ENV,
    beforeSend: scrubSentryEvent,
  });
  // `beforeSend` sees error events only; this drops every other item type.
  client?.on('beforeEnvelope', keepScrubbedItems);
}

const attachSentryErrorHandler = (app: Express): void => {
  if (sentryDsn) {
    Sentry.setupExpressErrorHandler(app);
  }
};

module.exports = { attachSentryErrorHandler, beforeSend: scrubSentryEvent };
