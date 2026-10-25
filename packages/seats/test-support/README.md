# test-support

`fake-provider.js` is a local scripted model server. A real agent CLI points its
provider base URL at it and runs a genuine turn with no key and no network. The
header comment in `fake-provider.js` lists the routes, directives, script turn
shape and capture fields; the tests under `../test` pin each behaviour.

## Wire coverage notes

- **Chat reasoning.** A thought (`[[think:X]]` or a script turn's `thought`) is
  sent as `message.reasoning_content` on a non-stream chat reply and as
  `delta.reasoning_content` chunks, ahead of any content, on a stream. That is
  the field DeepSeek-compatible and OpenRouter-compatible chat servers use; the
  OpenAI chat API has no reasoning field, so a client that ignores it reads the
  same answer.
- **Responses chaining.** A finished Responses reply is stored by id unless the
  request sent `store: false`. A request with `previous_response_id` continues
  from the stored context (the earlier input and output), so a follow-up can
  carry only a `function_call_output`. An unknown or unstored id gets HTTP 400
  `previous_response_not_found`, in the error shape OpenAI documents.
  `fake.chains` records `{ request, from, to, found }` for every chained
  request, and each Responses record carries `previousResponseId`,
  `responseId` and `priorItems`.

## Measured: stall and cut against real CLIs (2026-10-25)

Claude Code 2.1.310 and codex-cli 0.162.1, each installed with `npm install`
inside a `node:22-bookworm` container (linux/arm64). The network was detached
after the install, so the only reachable server was this provider on loopback,
behind a logging proxy. Each run had an empty HOME and a dummy key, and was
killed at 120 s if it had not exited. Claude Code ran `-p ... --output-format
stream-json --verbose`; codex ran `exec --json --skip-git-repo-check` with a
`wire_api = "responses"` provider. A cut is `[[cut:N:close]]` (N frames, then
the socket is closed) or `[[cut:N]]` (N frames, then silence with the socket
held open); N was 3 for Anthropic and 4 for Responses, about half the stream.

| CLI | case | what it did | exit | time | model requests |
|---|---|---|---|---|---|
| Claude Code | `[[stall]]` | waited; no output after the init event, no error | killed | 120 s | 1, no retry |
| Claude Code | `[[cut:3:close]]` | retried with backoff; `system/api_retry` events with `max_retries: 10`, `error: "unknown"`, `error_status: null`, delays 0.5, 1.1, 2.2, 4.2, 8.3, 17.6, 33.2, 39.7 s | killed mid-backoff | 120 s | 8 (6.3, 7.0, 8.4, 10.7, 16.2, 26.5, 46.4, 80.9 s), same body each time |
| Claude Code | `[[cut:3]]` | read 3 frames, then waited; no idle timeout fired | killed | 120 s | 1, no retry |
| codex | `[[stall]]` | waited after `turn.started`; no error | killed | 120 s | 1, no retry |
| codex | `[[cut:4:close]]` | `Reconnecting... 1/5` to `5/5` (`stream disconnected before completion: Transport error: network error: error decoding response body`), then `turn.failed` | 1 | 9.6 s | 6 (2.4, 2.7, 3.2, 4.0, 5.8, 9.1 s) |
| codex | `[[cut:4]]` | read 4 frames, then waited after `turn.started`; no error | killed | 120 s | 1, no retry |

Claude Code also sent one `HEAD /api/hello` before its first model request.
In one extra codex stall run, only the npm launcher was killed at 120 s; the
native binary it starts kept waiting on the same single request until it was
killed at 635 s. A harness that times codex out must kill the process group.

Over HTTP, codex 0.162.1 sent `store: false` and the full input on every
request (4 items, then 6 after a tool round) and never sent
`previous_response_id`. The upstream source at that tag sets it only on the
WebSocket transport, so the chaining support above is exercised by the tests
here, not by codex over HTTP.
