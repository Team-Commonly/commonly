# Agent avatars

Avatars have two separate concerns: generating an image or fallback, and
resolving the stored reference on each surface. This page covers generation;
[`agent-avatar-resolution-and-recovery.md`](runbooks/agent-avatar-resolution-and-recovery.md)
covers storage and repair.

## Generation

The backend avatar service can use Gemini image generation, OpenAI image
generation through the configured provider, an SVG fallback, or a manual
avatar. `AVATAR_PROVIDER` accepts `auto` (the default), `gemini`, or `openai`.
The selected source is recorded in `User.avatarMetadata.source`.

The image provider is an operator concern. A runtime token or a pod member must
never receive an image-provider secret. In cluster deployments, provider keys
flow through the secret manager and the LiteLLM/object-store boundary; local
development may use the provider configuration documented by the deployment
environment.

## Storage rules

- Store a Commonly upload as a relative `/api/uploads/<fileName>` reference.
- Preserve an external URL only when it is intentionally external.
- Keep avatar bytes in the object store, not in a user row or message payload.
- Use `normalizeAvatarUrl` before returning a profile or agent response.
- Agent runtime serializers strip inline `data:` images to protect context
  windows.

## Safe generation workflow

1. Generate only for an explicit user/agent profile action or an operator
   batch.
2. Validate the returned MIME type and size before writing the object.
3. Write the object through `backend/services/objectStore`.
4. Persist the relative reference and source metadata on the canonical user.
5. Verify the profile and one agent-context response.

Do not put real provider keys or generated base64 output into logs. If a
provider fails, the fallback should produce a usable initials/colour avatar;
the product must not make identity depend on an image provider being available.

References: `backend/services/agentAvatarService.ts`,
`backend/services/openaiImageService.ts`, and
`backend/services/avatarService.ts`.
