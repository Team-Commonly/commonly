# Instance Anthropic model availability

`ANTHROPIC_MODELS_AVAILABLE` is the single availability flag for the instance's
Anthropic route. It defaults to false. Key presence is insufficient: an expired
or rejected key still exists. After repairing the key, verify a request through
the instance route before setting this flag to `true` and redeploying the backend.
With Helm, set `backend.env.anthropicModelsAvailable: "true"`. Set it back to
`"false"` when that route is unavailable. Reload the screen after deployment.

The admin integrations API returns `modelAvailability.anthropic`, with
`available` and `reason`. The three Claude options remain visible, carry an
unavailable label and cannot be selected while disabled. A saved Claude model
is retained and shown honestly; the UI neither hides it nor chooses a replacement.
Saving model policy is disabled while Anthropic is selected and unavailable.
This is UI availability metadata, not a runtime kill switch or automatic fallback.

`GET /api/registry/presets` includes `recommendedModelAvailability` alongside
the unchanged recommendation. `GET /api/registry/model-availability` supplies
the same availability and the Claude Code preset's recommendation to the connect
screen without waiting for gateway capability discovery. Both routes require auth.

Claude Code's local/BYO adapter uses the person's own session. Its model options
remain selectable. At connection, the screen names the preset's recommendation
and explains the instance outage separately. The instance flag says nothing
about the person's external credentials.

## Surface scan (2026-10-25)

Searched `frontend/src`, `cli/src`, and `backend/routes` for `claude-`,
`recommendedModel`, and model picker/flag definitions.

- `GlobalIntegrations.tsx`: three instance model choices (Opus 4.6, Sonnet 4.6,
  Haiku 4.5); covered by the flag.
- `registry/presets.ts`: Claude Code recommends `claude-opus-4-6`; exposed with
  availability metadata and stated on the current connect screen. The legacy
  AgentsHub Presets tab was retired; no new tab is introduced.
- `V2AgentBYO.tsx`: local Claude aliases `opus`, `sonnet`, `haiku`, using the
  person's own account. Recommendation and instance notice are shown here.
- `AgentsHub.tsx`: model override choices contain no Claude model IDs.
- CLI `agent config --model <id>` and adapter model arguments are generic,
  user-supplied local runtime settings. They offer no fixed `claude-*` catalog
  and do not route through the instance key. They remain unchanged.

Browser evidence and fixture boundaries: [TASK-002 audit](../audits/shell-task-002/README.md).
