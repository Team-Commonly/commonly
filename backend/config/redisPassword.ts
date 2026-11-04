/**
 * The Redis AUTH password from REDIS_PASSWORD, whitespace-trimmed. This is the
 * single source every Redis client reads (socket.io adapter, the /api/health
 * probe, ops-runner, and any future client) so they all authenticate
 * identically.
 *
 * Why trim: a password written to GCP Secret Manager with
 * `gcloud secrets versions add --data-file=-` fed by `echo`/a heredoc carries a
 * trailing newline. Redis's own conf tokenizer strips it when it loads
 * `requirepass`, so the server's effective password is the trimmed value — but
 * a node-redis client sends process.env.REDIS_PASSWORD verbatim, newline and
 * all, and gets `WRONGPASS`. Trimming in one place keeps client and server in
 * agreement no matter how the secret was created (staging hit this 2026-11-04).
 *
 * Returns undefined when unset or blank, so a caller writes
 * `password: redisPassword()` and the local/dev no-auth path is unchanged
 * (node-redis sends no AUTH when password is undefined).
 */
export function redisPassword(): string | undefined {
  const raw = process.env.REDIS_PASSWORD;
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}
