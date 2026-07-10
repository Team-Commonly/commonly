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

      if (event.request) {
        scrubbedEvent.request = { ...event.request };
        delete scrubbedEvent.request.headers;
        delete scrubbedEvent.request.cookies;
        delete scrubbedEvent.request.data;
        delete scrubbedEvent.request.query_string;
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
