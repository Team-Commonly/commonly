/**
 * In-process runtime entry for harness plugins. This is the same consumer used
 * by `commonly agent run`: claims, cascade admission, pod-separated batches,
 * memory, delivery suppression and acknowledgement stay in the CLI.
 *
 * A native adapter implements `spawn(prompt, options)` and returns a Promise
 * of `{ text, newSessionId? }`. Resolve only for the exact completed input,
 * never merely because a shared session became idle. `options.metadata.event`
 * identifies the source pod/batch; native adapters must keep separate sessions
 * per pod. Runtime tokens in options are credentials, never prompt content.
 *
 * `performRun` returns `{ stop() }`. Stop prevents further polls but does not
 * cancel an already-started adapter or HTTP request. A plugin owns its adapter
 * cancellation/lifetime and must not cancel unrelated human work.
 *
 * This entry does not register/login an agent, enforce an OS sandbox around
 * an in-process harness, or make mutable global process.env safe per turn.
 * Do not replace adapter-scoped credentials with a shared global token.
 */
export { performRun } from './commands/agent.js';
