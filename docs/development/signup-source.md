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

Only a short ref code, an HTTP(S) referrer origin/path, an app-relative landing
path, and a timestamp are retained. URL queries, fragments and userinfo are
removed. Paths are bounded at 2048 characters; the whole browser payload is
bounded at 4096. The server independently sanitizes the input before temporary
OAuth storage and again before creating the account. Referrer paths can already
be absent because browsers apply their own referrer policy.

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
query/fragment/userinfo removal, static public pages, blocked browser storage,
and the OAuth form request in isolated Chromium at 390 and 1440.
