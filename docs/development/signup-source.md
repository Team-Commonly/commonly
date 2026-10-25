# Signup source

New human accounts retain an optional first browser touch in `User.signupSource`.
The auth method (`password`, `github`, `google`) and `recordedAt` are supplied by
the server at creation. `ref`, `referrer`, `landingPath` and `firstSeenAt` are
browser-reported attribution, not verified identity or authorization facts.
`firstSeenAt` is optional when storage was blocked or the browser clock was invalid.

`frontend/public/signup-source.js` runs from the real `frontend/index.html`
before React or redirects. Static public pages keep the script when the SEO
generator removes the React bundle. The first stored touch wins even when it
has no ref. Previously saved `commonly.firstTouchRef` codes remain usable for
older browsers. The old `onboarding.signupRef` is retained for Growth's readers.

Only a short ref code, an HTTP(S) referrer **origin**, an optional app-relative
landing path, and a timestamp are retained. Referrer paths are always discarded,
along with URL queries, fragments and userinfo; the stored origin is at most
256 characters. Landing inputs are bounded at 2048 characters. Both the browser
and server drop the entire landing path if a decoded segment is `invite` with
a following segment, a hex token of at least 24 characters, a UUID, or a token-like
segment of at least 32 characters containing uppercase letters, digits or token
punctuation. Matching decodes up to three layers; malformed or deeper escaping
also drops the path. Thus `/v2/invite/<bearer>` is absent from attribution, while
normal guide paths remain. This is a conservative filter for known routes and
token shapes, not a promise to identify every possible secret in arbitrary text.
New token-bearing routes must extend this rule or use a static route template.

The whole browser payload is bounded at 4096. The server independently sanitizes
the input before temporary OAuth storage and again before creating the account,
including input from an older browser that still has an unsanitized saved touch.

Password registration sends the source in its JSON body. OAuth buttons with
attribution use a form POST to `/api/auth/oauth/:provider/start`; the source
stays in the expiring, one-use `OAuthLoginState` row. Only the random state token
goes to the provider. Callbacks and completion URLs never carry the source.
The historical GET start still works for old clients; it accepts no new source
object. An existing-account login or provider link never sets or overwrites it.

The User schema makes the source and its fields immutable and excludes it from
ordinary queries. Growth's authorized server-side reads opt in with
`.select('+signupSource')`; no public profile field or new read endpoint is added.
Existing accounts remain without this field. No historical source is invented.

Verification covers all three auth methods against persisted Mongo rows,
real HTTP form parsing and login/replay paths, immutable dotted updates,
query/fragment/userinfo removal, decoded invite/token paths in both attribution
fields, referrer-origin reduction, static public pages, blocked browser storage,
and the OAuth form request in isolated Chromium at 390 and 1440.
