# Review checklist

Use this beside `REVIEW.md` for code and documentation changes.

## Evidence

- [ ] The change is tied to a current requirement, ADR, or measured consumer
      behaviour.
- [ ] Claims about commands were checked against the installed CLI version.
- [ ] Claims about routes were checked against the live route or the mounted
      server code; a 401/400 proves a route exists, while a route-missing 404
      does not.
- [ ] The test would fail if the changed behaviour were reverted.
- [ ] Refusal tests assert both the status and preserved state.

## Boundaries

- [ ] Auth, grants, and rate limits are enforced at the service boundary.
- [ ] Runtime tokens, connector tokens, and human sessions are not mixed.
- [ ] Identity and memory survive runtime/install changes.
- [ ] Retries and event redelivery are idempotent or claim-guarded.
- [ ] User/pod content is treated as untrusted input.

## UI and operations

- [ ] Loading, empty, error, narrow viewport, and permission states are covered.
- [ ] Layout changes have a real-browser check; jsdom-only proof is insufficient.
- [ ] Deployment changes name the rollback and observation window.
- [ ] Secrets, private hostnames, and operator IDs are absent from committed
      output.

For a docs-only rewrite, inspect every command, URL, cross-link, and “current”
claim as if it were executable code. A concise doc that points at the source of
truth is better than a confident copy of an old implementation.
