import * as Sentry from '@sentry/react';

const sentryDsn = process.env.REACT_APP_SENTRY_DSN;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    release: process.env.REACT_APP_VERSION,
    environment: process.env.NODE_ENV,
    beforeSend(event) {
      const scrubbedEvent = { ...event };
      delete scrubbedEvent.user;

      if (event.request) {
        scrubbedEvent.request = { ...event.request };
        delete scrubbedEvent.request.headers;
        delete scrubbedEvent.request.cookies;
      }

      return scrubbedEvent;
    },
  });
}
