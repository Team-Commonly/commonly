// Runs on static public pages as well as the app, before any redirect. This is
// attribution only: no query, fragment, URL credentials or request is retained.
(function () {
  var key = 'commonly.signupSource.v1';
  try {
    if (window.localStorage.getItem(key)) return;
    var source = { landingPath: window.location.pathname, firstSeenAt: new Date().toISOString() };
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
      if (url.protocol === 'https:' || url.protocol === 'http:') source.referrer = url.origin + url.pathname;
    }
    if (source.landingPath.length <= 2048) window.localStorage.setItem(key, JSON.stringify(source));
  } catch (_) { /* blocked storage must never prevent navigation or signup */ }
}());
