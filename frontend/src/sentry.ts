import * as Sentry from '@sentry/react';

const sentryDsn = process.env.REACT_APP_SENTRY_DSN;

const scrubInviteFromUrl = (raw: string): string => {
  try {
    const isAbsolute = /^[a-z][a-z\d+.-]*:/i.test(raw);
    const isProtocolRelative = raw.startsWith('//');
    const url = new URL(raw, 'https://commonly.invalid');
    url.searchParams.delete('invite');
    if (url.hash) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      hashParams.delete('invite');
      const nextHash = hashParams.toString();
      url.hash = nextHash ? `#${nextHash}` : '';
    }
    if (isAbsolute) return url.toString();
    if (isProtocolRelative) return `//${url.host}${url.pathname}${url.search}${url.hash}`;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return raw;
  }
};

const scrubBreadcrumb = (breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb => {
  if (!breadcrumb.data) return breadcrumb;
  const data = { ...breadcrumb.data };
  for (const key of ['from', 'to', 'url']) {
    if (typeof data[key] === 'string') data[key] = scrubInviteFromUrl(data[key]);
  }
  return { ...breadcrumb, data };
};

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    release: process.env.REACT_APP_VERSION,
    environment: process.env.NODE_ENV,
    beforeBreadcrumb(breadcrumb) {
      return scrubBreadcrumb(breadcrumb);
    },
    beforeSend(event) {
      const scrubbedEvent = { ...event };
      delete scrubbedEvent.user;

      if (event.breadcrumbs) scrubbedEvent.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);

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
