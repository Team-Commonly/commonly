# Agent Settings, D44 rev3 section 05

These are real Chromium captures of the local application with synthetic API responses. They are not production evidence. No real credentials are issued, read or revoked. All network API requests are intercepted.

The fixtures cover BYO, hosted, built-in Scout and never-connected agents in English and Chinese at 1440 and 390. Each has a page capture and separate Status/Runtime captures. The hosted fixture exercises Pause and waits for Resume after the persisted readback changes. Every capture reported no browser errors or horizontal document overflow. The final capture run waits for and verifies IBM Plex Sans/Mono loading. The English BYO fixture also opens Your Team at both widths, verifies the name stays ink and links back to Settings, then follows it. Non-owner names retain the public-profile destination.

Reference: section 05 of the rev3 artboard attached to TASK-546. The review bundle shared in the task pod contains that reference beside these captures; the source artboard is not copied into this directory.

## Readback contract

- Hosted and built-in model: `manage-settings.runtimeRun.model`, from the newest owner-scoped AgentRun in a manageable pod. No saved preference or UI model name stands in for a missing run.
- BYO model and effort: `runtimeObservation.lastSpawn`, the existing machine-bound spawn receipt. No receipt reads as “not reported”.
- The held task includes only its ID and pod name, and only where the viewer is a pod member. A non-member installation admin gets no task.
- Status Pause/Resume uses the existing installation PATCH with the exact instance ID. Existing machine reconnect, credential ownership checks, per-pod removal and memory conflict handling remain in their own components.
- Hosted and Scout request no credential ledger and render neither an Access key section nor a provider-key section. Scout has no usage meter or scheduled-turn estimate.
- A never-connected agent has one connect action and a folded Remove disclosure; the fixture opens it and captures the reachable removal control. Revoked runtime credentials remain folded. The credential endpoint already excludes spawn children.
- Local model controls use the machine-reported CLI inventory, with the existing user-supplied ID input when a CLI cannot enumerate models. TASK-002 owner Kai confirmed the source split: the instance catalogue is for hosted override choices; local CLI inventories remain independent. The runbook in #2707 explicitly says native Settings displays runtime truth. This page keeps the hosted/Scout model read only per rev3 and introduces no hosted override picker. That interpretation of the task’s picker clause is called out for task-owner review.

The existing OpenClaw Persona editor remains available inside the folded identity editor because its save path writes the runtime workspace’s `IDENTITY.md`. Other runtime kinds retain their existing name-only editor.

## Status and Runtime review follow-up

The capture fixture asserts that Pause, Copy and connect actions measure at least 44px at 390. Runtime without a spawn receipt says “On your machine, once connected” and omits the command hint. Placement is labelled “Bound to” so an Off agent does not claim to be running. Config flags are nonbreaking tokens; the desktop command aligns with the runtime value column. Last-turn dates use the selected language without seconds; Chinese location/model separators belong to the locale.

Scout retains Pause: the existing installation status PATCH accepts active/paused without a runtime restriction, and the event routing selects active installations. This control pauses the installation while preserving memory and membership, as requested in TASK-546. The model remains the raw ID from the run receipt, preserving its exact readback rather than inventing a display name.

## Reach per pod review follow-up

Heartbeat off hides the interval and daily-turn estimate. The capture exercises off → on → off for BYO, hosted and Scout at both widths in both languages, saves separate Reach crops, and measures the enabled interval select at a minimum 44px on phone. Scout still omits the turn estimate when enabled. The Chinese toggle is “心跳”; “间隔” labels only the select.

## What it can use review follow-up

The catalog search inherits the page font and has a 44px minimum height on phone. The grant revoke confirmation uses the same ink first action as other page confirmations. Run the fixture with `TOOLS_PROOF=1` to cover BYO/Scout with grants and loaded/conflicted skills, and hosted with no grants/skills, in en/zh at both widths. This mode opens the revoke confirmation without submitting it, checks its computed ink fill, opens the catalog, and checks search height and inherited font.

## Usage review follow-up

The userRunCeiling row identifies the owner's daily limit across all agents, including when an admin opens another owner's installation. Status and Usage share `formatAgentTimestamp`, which uses the selected app language and omits seconds. The default fixture saves BYO/hosted Usage crops and asserts the hosted owner-wide label and localized reset line in both languages. Scout continues to omit Usage.

## Reproduce

Start the normal frontend dev server on `127.0.0.1:3546`, then run `node capture.cjs` in an environment with Playwright installed. `PLAYWRIGHT_MODULE` can point to an existing installation; `OUTPUT_DIR` changes the destination. The fixture defaults to the system Chrome executable on macOS. If node_modules is a worktree symlink, allow its real directory in the local Vite server’s `server.fs.allow`; otherwise font URLs are refused. The capture asserts the Signal font loads before taking images. The source uses fake identities and a fixed receipt, so the displayed values can be checked against the intercepted responses.

## Completion holds

This is a draft implementation. UX review proceeds section by section, beginning with Status and Runtime. Independent gates and a non-author production walk of BYO/hosted/Scout at both widths with every displayed value checked against its real last spawn remain required. Captures alone do not complete TASK-546.
