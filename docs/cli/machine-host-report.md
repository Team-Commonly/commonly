# What a daemon machine reports about its computer (TASK-784)

`commonly daemon register` and every supervisor check-in send a `host` report next to the existing `sandbox` report. The report is metadata only:

| Field | Value | Example |
|---|---|---|
| `platform` | Node's `process.platform` | `win32`, `darwin`, `linux` |
| `osMajor` | the leading number of `os.release()` | `10` (Windows), `25` (Darwin kernel), `6` (Linux kernel) |
| `arch` | Node's `process.arch` | `x64`, `arm64` |
| `cliVersion` | the `@commonlyai/cli` version that sent it | `0.1.245` |

The CLI builds the report in `cli/src/lib/machine-host.js`. The server stores it as `Machine.host`, through `normalizeHostReport` in `backend/services/machineService.ts`. That function checks each field against a fixed shape (Node's own platform and arch names, an integer, a semver) and drops anything else. So a hostname, a path or a user name can't be stored, whatever a caller sends.

A machine also records `firstAnswerAt`: the first time an agent bound to it acked an event a person was waiting on (`chat.mention`, `thread.mention` or `dm.message`, the `PERSON_WAITING_EVENT_TYPES` set) with outcome `posted`. It's set once and never moved, and a failure to set it never fails the ack.

Admins read the counts at `GET /api/admin/analytics/machines`, and in the "Daemon machines" section of the admin usage page:
- machines by platform, with how many have answered a person. A mention from another agent or a kernel wake doesn't count, even though an agent's DM arrives as `chat.mention`;
- machines by CLI version.

## What these counts can't see

- **Whether a machine is online.** The total counts every registered machine, including stopped ones.
- **Foreground runs.** `commonly agent run` in a terminal registers no machine, so it's never counted. The Windows prod walk (byo-windows.yml run 41926949969) ran that way. These counts cover daemon machines only.
- **Whether a reply was really posted.** `posted` is the outcome the seat's own ack reports. Nobody checks it against a message, so a seat that acks `posted` without posting still counts its machine as answered.
- **Anything before the release.** `firstAnswerAt` starts when this ships. A machine whose agents answered people before then reads "not answered" until it answers again.
- **Machines on an older CLI.** A machine registered by an older CLI shows "Not reported" until a newer CLI checks in from it. An older CLI that never upgrades stays "Not reported".
- **Windows 10 against 11.** Both report `osMajor` 10, because Windows 11 still reports release `10.0.<build>`, and the build number isn't stored.
- **Darwin kernel numbers.** On a Mac, `osMajor` is the Darwin kernel major (25), not the macOS marketing version.
