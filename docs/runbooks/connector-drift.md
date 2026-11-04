# Hosted-MCP connector drift

A hosted-MCP connector offers only the tools its catalogue entry pins
(`backend/integrations/hostedMcp/<vendor>.ts`). When a vendor changes a pinned
tool, the broker refuses it rather than forward a call the pin never reviewed.
This runbook covers how to find drift, measure it and re-pin.

Code: `backend/services/hostedMcpEntryService.ts` (`assessEntryTools`) and
`backend/services/hostedMcpDriftAlertService.ts`.

## How drift shows up

**A refusal.** The broker assesses each pinned tool against the row's own
`tools/list` and returns one of four verdicts:
- `ok`: the tool matches, or a read changed compatibly. "Changed compatibly;
  using the pin" is logged and the pin stays.
- `tool_drift`: a read's schema changed incompatibly, a write's schema changed
  at all (descriptions included), or the annotations moved toward write. The
  tool is refused until a PR re-pins it.
- `tool_unavailable`: this row's list doesn't include the tool. That usually
  reflects what the row's owner consented to (Sentry without Triage, a
  read-only Linear scope), **not** a vendor change. Don't re-pin for it.
- `not_granted`: a write pin the list leaves out because the row's recorded
  scope lacks the entry's write scope. It isn't logged as a change, files no
  card, and a call refuses with `write_scope_required`. The row's owner can
  reconnect with write consent. Nothing here is drift.

**Connectors v2.** The tool row shows "the provider changed this tool since
Commonly checked it" (`frontend/src/v2/connectors/useToolConnectors.ts`).

**The drift alert card.** Each new `tool_drift` files one Needs-you card,
"<Vendor>: N pinned tools changed upstream", for the operator who re-pins. It
goes to the recipient and pod set in SystemSetting `hostedMcp.driftAlert`
(`{ recipientUserId, podId }`). That's set per instance and never committed. If
the setting is missing or the card can't be delivered, the alert fails with a
`console.error` naming the reason, at most once an hour while it lasts. It's
never silently dropped. `tool_unavailable` never files a card.

## Census: how far a drift reaches

Use what the broker has already assessed. **Never take a list with someone
else's credential.** A list is only valid for the row whose credential took it,
and operators don't hold users' credentials.

1. Read the backend's `hosted_mcp_tool_assessment` log lines. Each line carries
   `entryId`, `connectionId` and the tools whose verdict isn't plain `ok`, with
   names and details from the pin and our comparison, never vendor text. Every
   line comes from an assessment the broker ran with that row's own
   credential, cached for 5 minutes per row.
2. Group by `entryId` and tool name, and count the rows. Split `tool_drift`
   from `tool_unavailable`: only the first says anything about the vendor.
3. If no row has used the connector recently, there are no lines. Assess a
   team-owned row by using the connector
   from a seat that holds that row's grant.

For prod reads, follow the read path in `ops-runner-and-no-exec-into-backend.md`.
Never exec into the serving backend.

## Re-pinning from a fresh capture

The pattern used by #3283 (Sentry 11-01, merged), and by #3396 (Sentry 11-04) and
#3398 (Notion and Atlassian 11-04), both still open:

1. **Capture** the vendor's `tools/list` from a team-owned row consented to the
   widest scope the entry pins (Sentry: a Triage-consented row, or
   `update_issue` can't be checked). Commit it as
   `backend/__tests__/fixtures/hostedMcp/<vendor>-tools-list-<YYYY-MM-DD>.json`.
2. **Re-pin only the drifted tools.**
   - Take each one's input schema and annotations from the capture, and keep
     our own description.
   - A **write** pin must match the live schema exactly.
   - A **read** pin may leave out new optional properties: the broker then
     refuses those arguments by name.
   - Pins that still assess `ok` stay as they are.
3. **Never add a tool in a re-pin.** Tools the vendor has newly listed each need
   their own review.
4. **Update the entry's header comment**: which capture backs which pins, and
   why each exclusion stands.
5. **Write the tests** in `backend/__tests__/unit/services/hostedMcpEntry.test.js`:
   - name the capture behind each pin, and fix the pinned set by name;
   - assert every pin assesses `ok` on the new list;
   - assert the old pins are exactly the ones that drift.
6. **Update the vendor's row** in `docs/plans/integration-readiness-matrix.md`.

A read re-pin is tier 1. A re-pin that restores write tools, or admits new
vendor fields into a write pin, is tier 2 review.

### Which read changes count as compatible

Today only two kinds of change to a read pin are compatible: description text
at any depth, and a new optional top-level property. Ruled on #3396
(2026-11-04), not yet built:
- **Ships as a follow-up:** a name removed from `required` while its property
  stays the same, and a nullable written differently (`anyOf` with
  `{type: "null"}` vs `type: [T, "null"]`) both become compatible.
- **Waits:** added `enum` values wait until argument values are checked
  against the pin.
- **Stays drift:** a changed `pattern`, `format`, min or max, and any removed,
  retyped or narrowed property.

## Tracking-only fields: strip on forward

Some vendors add optional fields that describe the caller rather than the call.
Notion's writers gained `skill`, `instructions_version` and `telemetry` on
2026-11-04. Ruling on #3398:
- Write pins carry these fields as captured, because a write pin must match
  exactly.
- An entry-level strip list then drops any value in them after the name check
  and before forwarding, on both the direct and the approved path. The Notion
  entry declares all three.

**The strip list is not built yet.** Until it lands, a value the model puts in
these fields reaches the user's own Notion workspace along with the write. When
a new vendor adds a field like this, add it to that entry's strip list in the
same re-pin. Don't leave it out of a write pin.
