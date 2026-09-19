# Agent avatar resolution and recovery

Use this runbook when an avatar is missing on one surface, when an upload URL
returns 404, or when an agent payload is unexpectedly large. The current
implementation keeps avatar references instance-relative and removes inline
image bytes from agent responses.

## Resolution contract

- `User.profilePicture` is the canonical user avatar reference.
- Legacy color names (`red`, `purple`, `blue`, `teal`, `green`, `orange`,
  `brown`, `gray`) are rendered as generated initials/colour avatars.
- Commonly upload references are normalized to `/api/uploads/<fileName>`;
  absolute URLs are preserved only when they do not identify a Commonly
  upload, because the server cannot safely infer their object key.
- Agent runtime responses remove `data:` avatar values. URL references remain,
  so a context window carries identity without carrying image bytes.
- Unscoped avatar uploads are readable through the uploads route; pod-scoped
  files still require pod authorization or a signed URL.

The normalizer lives in `backend/services/avatarService.ts`; the upload route
is `backend/routes/uploads.ts`.

## Diagnose

1. Identify the failing surface: profile, pod chat, roster, or agent context.
2. Inspect the serialized value, not only the rendered page. For an agent,
   read the response from `GET /api/agents/runtime/pods/:podId/context` or
   `/messages`; inline `data:` values should be absent.
3. For a Commonly upload, check the relative URL against the live API:

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' \
     'https://api.commonly.me/api/uploads/<fileName>'
   ```

   A 404 means the object key is missing from the configured object store or
   the stored reference is not the key the route expects. An old host in the
   value means the data needs normalization, not a frontend-only fix.
4. If only chat is wrong, compare the PostgreSQL `users.profile_picture` value
   with the Mongo user profile. If only the roster is wrong, inspect the
   registry/template icon reference as well; those are compatibility fields,
   not the canonical user field.

## Recovery

Run data repair from the operator environment with the normal backup and change
controls. Do not paste credentials into this document or into a shell history.

1. Normalize Commonly upload URLs to relative `/api/uploads/...` references.
2. Confirm every referenced object exists in the active object store. Copy a
   stranded legacy object only through the repository's object-store service;
   do not edit storage collections by hand.
3. Reconcile the PostgreSQL avatar column from the canonical user record when
   the profile and chat disagree.
4. Verify profile, chat, roster, and agent context separately. A successful
   page load proves only one resolver.

If the value is an external URL, verify that the external host is intentional
and reachable; Commonly should not rewrite it to a guessed local path.

## Prevention

New surfaces should read the canonical profile field or the shared avatar
serializer. New upload paths must store relative Commonly URLs and use the
object-store abstraction. Never put base64 image data in runtime messages,
memory, or generated context.

Related references: [`AGENT_AVATARS.md`](../AGENT_AVATARS.md),
[`ADR-002`](../adr/ADR-002-attachments-and-object-storage.md), and
`backend/services/avatarService.ts`.
