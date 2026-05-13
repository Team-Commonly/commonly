# Sign-up flow — design rationale

## Auth provider order

Per slide 3 of `auth-flow-wireframes.pptx`: **OAuth-first, email as fallback.**

Spec previously assumed email-first. Recommendation: update the spec.

### Why OAuth-first

- Wedge user is a developer — already authenticated on GitHub on this machine
- Zero code-paste step on the OAuth path; one tap
- Earlier `signup_source` signal flows into our analytics

### Open question

What % of dev visitors arrive already logged into GitHub? If <60%,
email-first is the better default. Sam to pull the number before
we lock the order.
