import type { Express } from 'express';

const Sentry = require('@sentry/node') as typeof import('@sentry/node');

const sentryDsn = process.env.SENTRY_DSN;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    release: process.env.SENTRY_RELEASE,
    environment: process.env.NODE_ENV,
    beforeSend(event) {
      const scrubbedEvent = { ...event };
      delete scrubbedEvent.user;
      // Errors from OAuth vendors or secret storage may embed token values in
      // their message, stack, or attached context. Keep the event count and
      // status, but send no exception text or request URL to Sentry.
      if (event.message) scrubbedEvent.message = 'Unhandled request error';
      if (event.exception) {
        scrubbedEvent.exception = { values: [{ type: 'Error', value: 'Unhandled request error' }] };
      }
      delete scrubbedEvent.extra;
      delete scrubbedEvent.breadcrumbs;
      delete scrubbedEvent.contexts;
      delete scrubbedEvent.logentry;
      delete scrubbedEvent.tags;
      delete scrubbedEvent.fingerprint;
      delete scrubbedEvent.transaction;

      if (event.request) {
        scrubbedEvent.request = { method: event.request.method };
      }

      return scrubbedEvent;
    },
  });
}

const attachSentryErrorHandler = (app: Express): void => {
  if (sentryDsn) {
    Sentry.setupExpressErrorHandler(app);
  }
};

module.exports = { attachSentryErrorHandler };
