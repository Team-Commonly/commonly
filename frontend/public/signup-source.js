// Runs on static public pages as well as the app, before any redirect. This is
// attribution only: no query, fragment, URL credentials or request is retained.
(function () {
  var key = 'commonly.signupSource.v1';
  // Keep aligned with backend/utils/signupSource.ts; the server repeats this
  // check for old or forged clients. Drop known invite routes and token shapes.
  function hasCapabilityPath(pathname) {
    var decoded = pathname;
    for (var i = 0; i < 3 && decoded.includes('%'); i += 1) decoded = decodeURIComponent(decoded);
    if (decoded.includes('%')) return true;
    var segments = decoded.split('/');
    return segments.some(function (segment, index) {
      return (segment.toLowerCase() === 'invite' && index < segments.length - 1)
        || /^[a-f0-9]{24,}$/i.test(segment)
        || /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(segment)
        || (segment.length >= 32 && /^[a-z0-9_.~+=-]+$/i.test(segment) && /[A-Z0-9_.~+=]/.test(segment));
    });
  }
  try {
    if (window.localStorage.getItem(key)) return;
    var source = { firstSeenAt: new Date().toISOString() };
    try {
      if (window.location.pathname.length <= 2048 && !hasCapabilityPath(window.location.pathname)) {
        source.landingPath = window.location.pathname;
      }
    } catch (_) { /* malformed encoded path is not attribution */ }
    var ref = new URLSearchParams(window.location.search).get('ref');
    ref = typeof ref === 'string' ? ref.trim().toLowerCase() : '';
    if (/^[a-z0-9_-]{1,32}$/.test(ref) && !['__proto__', 'constructor', 'prototype'].includes(ref)) source.ref = ref;
    // Preserve the established ref for browsers that arrived before this field.
    if (!source.ref) {
      try {
        var old = JSON.parse(window.localStorage.getItem('commonly.firstTouchRef') || 'null');
        var oldRef = old && typeof old.ref === 'string' ? old.ref.trim().toLowerCase() : '';
        if (/^[a-z0-9_-]{1,32}$/.test(oldRef) && !['__proto__', 'constructor', 'prototype'].includes(oldRef)) source.ref = oldRef;
      } catch (_) { /* optional legacy value */ }
    }
    if (document.referrer && document.referrer.length <= 2048) {
      var url = new URL(document.referrer);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.origin.length <= 256) source.referrer = url.origin;
    }
    window.localStorage.setItem(key, JSON.stringify(source));
  } catch (_) { /* blocked storage must never prevent navigation or signup */ }
}());
