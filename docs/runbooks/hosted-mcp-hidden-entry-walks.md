# Walk a hidden hosted MCP entry

Instance policy `hostedMcp.hiddenEntries` hides entries from the Tools catalogue
and refuses new connect/reconnect starts. To offer one hidden entry to a named
walk user, configure an exception alongside the hidden list:

```yaml
hostedMcp:
  hiddenEntries: [sentry]
  hiddenEntryUserAllowlist:
    sentry:
      - "0123456789abcdef01234567" # example only; replace with the walk user's User._id
```

Set real IDs only in operator-local deployment values. Both backend and ops-runner
receive the JSON map as `HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST`. The default is
an empty map. A deployment is required to change the environment.

The map is entry ID to an array of exact, lowercase, 24-character Mongo User IDs.
Names, email addresses, roles, query parameters and request body fields do not
grant an exception. Catalogue reads and authenticated connect starts use the
server-authenticated user's ID. A missing user or malformed map grants no
exceptions; one invalid map member invalidates all exceptions. An exception key must also
name an entry in the configured hidden list; a stale or mistyped key invalidates
the entire exception map. Other users
continue to see no offering and receive `404 unknown_entry` on start.

An exception does not configure a connector client, grant access to another
person's connections, or change tool grants. An unconfigured client remains
unavailable. Existing hidden connections retain their removal surface and pinned
broker tools as before. Public client metadata and callbacks are not new-offering
checks: the former is fetched by authorization servers, and the latter already
validates an owner-bound pending OAuth state.

Before enabling the walk, confirm the selected User ID with the operator. After
the walk, remove that ID and deploy again. Record the revision and verify the
named user can no longer start a new connection, while existing connections can
still be removed. Do not widen the global hidden list just to run one walk.
