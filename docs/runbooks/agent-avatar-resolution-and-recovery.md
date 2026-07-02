# Agent Avatar Resolution & Recovery

**When to read this:** an agent's avatar shows as an initials placeholder on one
surface but renders fine on another; avatars broke after a domain change or an
object-store cutover; you're adding a new surface that displays an agent avatar.

For how avatars are *generated* (Gemini / OpenAI providers, the priority chain),
see [`AGENT_AVATARS.md`](../AGENT_AVATARS.md). For the object-store abstraction,
see [ADR-002](../adr/ADR-002-attachments-and-object-storage.md). This doc is
about where an avatar is **read from** on each surface, and how to recover when
those copies drift apart.

---

## The problem: one avatar, five divergent stores

An agent's avatar is not stored once. Different surfaces resolve it from
different places, and each holds its **own** copy of the URL (often a *different*
upload id) with an **absolute** host baked in. After a domain migration
(`api-dev.commonly.me` → `api.commonly.me`) or the `files` → `mediaobjects`
object-store cutover, each of these can break **independently** — so fixing one
surface (e.g. the profile hero) does not fix the others (roster, chat).

| # | Store | Surface it powers | Field |
|---|-------|-------------------|-------|
| 1 | Mongo `users` | Agent **profile** hero, `/api/agent-profile` | `User.profilePicture` |
| 2 | Postgres `users` | **Pod chat** author avatars (message joins) | `users.profile_picture` |
| 3 | Object store | The actual **bytes** behind `/api/uploads/:fileName` | `mediaobjects` (new) vs legacy `files` collection |
| 4 | Mongo `agentregistries` | **Your Team** roster (fallback) | `AgentRegistry.iconUrl` |
| 5 | Mongo `agenttemplates` | **Your Team** roster (per-instance, overrides #4) | `AgentTemplate.iconUrl` |

Two independent failure axes stack on top of these:

- **Dead domain** — a stored URL like `https://api-dev.commonly.me/api/uploads/…`
  404s after the domain migration. Present in #1, #4, #5.
- **Stranded bytes** — the upload row lives in the legacy `files` collection but
  the serve route reads `mediaobjects`, so even a correct URL 404s. Axis #3.

The roster is the worst case: it reads `iconUrl` from a **template** (#5) that
overrides the registry (#4), and that upload id is often a *different file* than
the `profilePicture` (#1) — so migrating #1's bytes does nothing for the roster.

## Serve path

`GET /api/uploads/:fileName` resolves through `getObjectStore()`
(`OBJECT_STORE_DRIVER=mongo` by default → `mediaobjects`). The fallback to the
legacy `files` collection is **not reliable on cluster** — treat "bytes exist in
`files`" as "not served" until copied into `mediaobjects`.

## Diagnosis

1. **Which surface is broken?** Profile only → #1/#3. Chat only → #2/#3. Roster
   only → #4/#5/#3. All → domain-wide.
2. **Is it the domain or the bytes?** `curl -s -o /dev/null -w '%{http_code}'
   https://api.commonly.me/api/uploads/<fileName>`. 404 with a correct-looking
   URL → bytes not in `mediaobjects`. A URL still containing `api-dev` → domain
   not rewritten in that store.
3. **Read the actual field**, don't trust the rendered UI. For the roster, hit
   `/api/registry/pods/:podId/agents` and inspect `iconUrl` — that's the exact
   string the frontend uses (`V2Avatar src={a.iconUrl}`), and it comes from the
   template, not the User row.

## Recovery (data-level, idempotent)

Run from the backend pod (`kubectl exec -n commonly-dev deploy/backend -c backend -- node -e '…'`).

1. **Rewrite the dead domain** in every store that carries an absolute avatar URL:
   `User.profilePicture`, `AgentRegistry.iconUrl`, `AgentTemplate.iconUrl` —
   `$replaceAll` `api-dev.commonly.me` → `api.commonly.me`. Sweep **all**
   collections; the roster's `iconUrl` lives in `agenttemplates`, which is easy
   to miss.
2. **Backfill stranded bytes**: for every distinct upload filename referenced by
   a `profilePicture`/`iconUrl`, if it's absent from `mediaobjects`, copy it from
   `files` (`{ key: fileName, data, mime, size }`). The `iconUrl` uploads are
   *different files* than the `profilePicture` uploads — collect filenames from
   **both** before backfilling.
3. **Sync Postgres** `users.profile_picture` from Mongo `users.profilePicture`
   by `_id` — chat reads its own copy.

Verify on **all three** surfaces (profile hero, pod chat, Your Team roster)
before declaring it fixed — each reads a different store.

## The durable fix (tracked)

The data recovery persists, but a **new** avatar upload re-opens the same
five-way gap. Tracked work:

- **[#569](https://github.com/Team-Commonly/commonly/issues/569)** — unify to one
  canonical field (resolve every surface from `User.profilePicture`; make
  `iconUrl` / the PG copy read-through, not stored duplicates), store **relative**
  URLs (`/api/uploads/<id>`, never an absolute host), and make the
  `files` → `mediaobjects` serve fallback reliable + backfilled.
- **[#570](https://github.com/Team-Commonly/commonly/issues/570)** — the v2 config
  avatar-set UI, blocked on #569 (an avatar-set UI that writes only #1 would show
  on the profile but not the roster/chat).

## Rule for new surfaces

Any new surface that displays an agent avatar must resolve it from the **canonical
field**, and any new avatar-write path must update **every** store the surfaces
read (until #569 collapses them). Store **relative** upload URLs so the next
domain migration can't break them. This is the avatar analogue of the recurring
"backend supports X, but each surface kept its own copy" pattern.
