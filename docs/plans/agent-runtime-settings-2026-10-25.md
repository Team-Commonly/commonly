# Agent runtime settings

TASK-435 implements the approved Settings artboard, revision 2. The shared
contract is the UX Lead's inline message 84405. The OAR study's ruling is to
port the ideas and retain Commonly's daemon, CAP and connector secret ring.
No OAR dependency or Raft source is introduced.

## Boundaries

Saved controls come from the same installation projection the daemon reads.
The additive `runtimeSavedControls` field also exposes stored preferences on
read-only seats; older `runtimeControls` callers retain their former semantics.
Last-spawn controls come from the runner at actual process creation, after
adapter argument construction, and contain only harness, version, model,
effort and timestamp. Runtime confirmation is a separate optional report;
absence remains null and renders as unconfirmed. Never derive either of the
latter from saved configuration. Never upload raw argv, environment, prompts,
paths or provider response bodies as runtime diagnostics.

Machine capability reports list the installed, walked harnesses and versions.
Options come from that computer. Missing model inventory permits a text field
and a next-spawn check. Missing effort inventory permits only harness default;
an unsupported stored effort remains visible but is not passed. Validation on
save and the actual adapter launch must agree. A declared supported choice
must never be silently replaced with another value.

Process connection and runtime progress remain separate signals. Runner facts
refresh every 30 seconds without reloading form drafts. An unavailable read or
a seat without machine telemetry is unreported, rather than disconnected. A desired
configuration edit must not terminate a running turn. It is loaded on the next
spawn. Pending compares saved controls with the last-spawn receipt, except
for an effort the runner explicitly cannot send.

## Keys

The management API may set or remove an agent's provider key. Reads expose
only set, setAt, setBy and lastUsedAt. The connector secret ring owns encryption
and key rotation. Agent config, projections, readback, transcripts, logs and
model/tool environments must never contain plaintext provider material.

Provider delivery must use a confined provider proxy or equivalent per-runtime
boundary, with an ephemeral request credential. A generic environment overlay
with the plaintext vendor key does not satisfy this contract.

The product ruling on 2026-10-25 is **confined modes only**. Own-key controls
are enabled only for daemon-managed OpenCode with an explicit provider and
public workspace/read-only/bwrap confinement. Claude, Codex, Hermes, dsh and
unconfined modes have disabled key controls. Claude/Anthropic and Codex/OpenAI
mappings do not authorize a bearer-env exception.

Owner GET/PUT/DELETE responses contain only the four metadata fields. A separate
root-runner-only launch POST resolves material into the parent process, which
hands it directly to the existing per-spawn proxy. It is never written to a
vendor-key file or passed through model/tool env. Spawn credentials cannot call
that endpoint. A changed provider ID or destination refuses before resolution.
Each set creates immutable encrypted material and atomically binds its ref with
the destination; generation fences prevent late sets and removal cleanup from
overwriting a newer choice. The secret sweep retains only referenced material.
`lastUsedAt` records the last authorized launch resolution, not vendor success.

Authorization binds management to the current installer and selected machine,
using the existing sole-installer and machine-authorization checks. An agent's
spawn bearer cannot edit saved settings or read provider material. Provider
requests must remain bound to that agent, provider and launch; no arbitrary
upstream URL, redirect, owner or installation may be supplied by the caller.

## Settings presentation

Each harness/model/effort row shows saved, last spawn and confirmed values.
A pending cobalt dot appears only when a value will change on the next spawn.
The hint is “changes apply on the next spawn”. Unsupported choices retain
their stored value in danger text and name what ran. Uninstalled walked
harnesses remain listed but disabled.

Meta uses Plex Mono 11, controls use existing Signal tokens, filled actions
are ink, and Remove uses danger text. Read-only hosted and standalone CLI
seats keep all three columns, disabled controls, no Save, the specified
read-only hint, and no key buttons. Key input must clear after success and
must not be restored from any server response or browser storage.

## Proof required before release

- Owner save reaches the selected machine's next actual spawn without
  interrupting an active turn; three independent values read back correctly.
- Unsupported inventory choices fail before writes/spawn; missing inventory
  preserves the model-text and effort-default behaviors.
- Real CLI argv witnesses cover each walked harness, resume and recovery.
  A report containing prompt/secret-like extra fields is refused or discarded.
- Cross-owner, wrong-machine, revoked credential and spawn-token mutation
  attempts fail without writes or plaintext disclosure.
- Key lifecycle tests inspect persisted rows, config/read responses, spawn
  args, environment, tool-child environment and logs; fake provider requests
  prove the confined path authenticates without exposing the vendor key.
- Browser checks cover set/refuse/confirm/key input/menu and missing-inventory,
  refused-spawn and read-only states at 1440 and 390, in English and Chinese.
- Code, security and UX gates bind the final head. CI is required. No partial
  UI release before the complete artboard contract is implemented.
