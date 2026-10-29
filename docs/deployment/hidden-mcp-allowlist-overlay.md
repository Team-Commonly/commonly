# The `DEV_HELM_HIDDENMCP_ALLOWLIST` secret is a YAML overlay, not a word list

**One-line trap:** `DEV_HELM_HIDDENMCP_ALLOWLIST` (a GitHub Actions secret used
by `deploy-dev.yml`) is **not** a comma- or space-separated list of entry names.
Its entire value is the text of a Helm **values overlay file**. Setting it to
`atlassian,sentry,airtable` silently produces an invalid overlay.

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

So the secret's value **is** `allowlist.yaml`. It must be a complete, valid
Helm values document whose keys merge onto the chart. If the secret is unset or
empty the step writes an empty overlay (a no-op merge), which is the intended
"no allowlist" default — not an error.

## What the overlay must contain

It overrides `hostedMcp.hiddenEntryUserAllowlist` — a **map** of hidden
hosted-MCP entry name → list of Mongo user `_id`s permitted to walk that entry.
This block used to live in `values-dev.yaml`; it was moved into the secret so
the per-user allowlist stays out of the public repo.

```yaml
# shape only — real user ids are NOT committed; they live in the secret
hostedMcp:
  hiddenEntryUserAllowlist:
    atlassian:
      - "<USER_ID>"
    sentry:
      - "<USER_ID>"
    airtable:
      - "<USER_ID>"
```

## Editing it

- To allowlist a newly-hidden entry, add a **key** under
  `hiddenEntryUserAllowlist` with its user-id list — edit the YAML, not a word
  list.
- `gh secret set DEV_HELM_HIDDENMCP_ALLOWLIST --repo <repo> --body-file <overlay.yaml>`.
  Never paste ids on the command line or into logs.
- The set of **hidden** entries themselves is a separate field
  (`hostedMcp.hiddenEntries`, a plain list) that stays in `values-dev.yaml`.
  Only the per-user allowlist is overlaid from the secret.
- Each entry's list is YAML; an entry present with an empty list is not the same
  as the entry being absent.

> Earned 2026-10-29: the name reads like a feature-flag word list, and treating
> it as one would drop every allowlisted user on the next deploy.
