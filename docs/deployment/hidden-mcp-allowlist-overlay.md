# The `DEV_HELM_HIDDENMCP_ALLOWLIST` secret is a YAML overlay, not a word list

**One-line trap:** `DEV_HELM_HIDDENMCP_ALLOWLIST` (a GitHub Actions secret used
by `deploy-dev.yml`) is the text of a Helm **values overlay file** — a map, not a
comma- or space-separated list of entry names. A bare word list like
`atlassian,sentry,airtable` does **not** fail silently: `helm` refuses to
unmarshal a scalar string into the map-typed value (`cannot unmarshal string
into Go value of type map`) and the deploy fails loudly, so the running release
keeps its current allowlist. The failures that drop users *silently* are
different, and they are the ones to guard against:

- **The secret is unset or empty at the deploy that removes
  `hiddenEntryUserAllowlist` from `values-dev.yaml`.** The chart default is `{}`,
  so every hidden entry is then hidden from *all* its users — every exception is
  removed. **Set the secret before that deploy.** (Entries themselves have been
  hidden since an earlier change; the exposure is the map moving out of the
  committed values into the secret.)
- **The overlay parses but is semantically invalid** — see "What the overlay
  must contain". The backend then throws the whole allowlist away (`{}`), with
  the same effect.

## How it is consumed

The `Deploy Dev` workflow materializes the secret to a file and passes it to
`helm` as the last `-f`, after `values-dev.yaml`:

```yaml
# .github/workflows/deploy-dev.yml  (step: Materialize hosted-MCP allowlist overlay)
printf '%s\n' "${DEV_HELM_HIDDENMCP_ALLOWLIST}" > "$RUNNER_TEMP/allowlist.yaml"
# ... later ...
helm upgrade ... -f k8s/helm/commonly/values-dev.yaml \
  -f "$RUNNER_TEMP/values-private.yaml" \
  -f "$RUNNER_TEMP/allowlist.yaml" ...
```

So the secret's value **is** `allowlist.yaml`. It must be a complete, valid Helm
values document whose keys merge onto the chart. An unset or empty secret writes
an empty overlay, which merges the chart default `{}` — i.e. no exceptions.

## What the overlay must contain

It overrides `hostedMcp.hiddenEntryUserAllowlist` — a **map** of hidden
hosted-MCP entry name → list of authenticated user `_id`s permitted to see that
entry. (It feeds `HOSTED_MCP_HIDDEN_ENTRY_USER_ALLOWLIST`, read by
`backend/integrations/hostedMcp/visibility.ts`.) The per-user allowlist was
moved out of `values-dev.yaml` into the secret so the ids stay out of the public
repo.

```yaml
# shape only — real user ids are NOT committed; they live in the secret
hostedMcp:
  hiddenEntryUserAllowlist:
    atlassian:
      - "<USER_ID>"   # a 24-hex-char user _id
```

**The backend validates the whole overlay atomically.** Each key must also be in
`hostedMcp.hiddenEntries`, must match `^[a-z0-9][a-z0-9-]*$`, and every id must
be 24 hex characters. If **any** key or id fails, the backend discards the
**entire** allowlist (not just the bad entry) and grants no exceptions. One
malformed id silently hides every allowlisted entry from everyone.

## Editing it

- To grant a user access to a hidden entry, add or extend that entry's key with
  their 24-hex-char `_id`. Edit the YAML, not a word list.
- `gh secret set DEV_HELM_HIDDENMCP_ALLOWLIST --repo <repo> --body-file <overlay.yaml>`.
  Never paste ids on the command line or into logs.
- **Merge order:** set the secret before the deploy that removes the map from
  `values-dev.yaml`, or that deploy's chart-default `{}` removes every exception.
- **Un-hiding trap:** `hiddenEntries` (the list of hidden entries) lives in
  `values-dev.yaml`; the per-user allowlist lives in the secret. When you remove
  an entry from `hiddenEntries` (un-hide it), remove its key from the secret in
  the **same change** — an allowlist key for an entry that is no longer hidden
  fails validation and voids the *entire* allowlist, silently dropping every
  allowlisted user across all entries.
- An entry with an empty list and an entry omitted entirely both leave that entry
  hidden for everyone; neither grants access. Access requires a non-empty list of
  valid ids.

> Earned 2026-10-29: the name reads like a feature-flag word list. A word list
> would at least fail the deploy loudly; the real hazard is the silent
> exception-drop when the secret is unset/empty at the deploy that removes the map
> from `values-dev.yaml`, or when an un-hidden entry's key is left behind in the
> overlay.
