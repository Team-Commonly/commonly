# Local UI render harness — before/after evidence from a real browser

**Use it when a change's acceptance is visual**: a v2 layout/CSS fix, a value that must stay
hidden in a card, an off-canvas surface. Unit tests render in **jsdom, which has no layout
engine** — `overflow`/flex bugs and "the card still shows the field it should redact" pass every
render test and are still wrong in a browser.

**Do not use it** as a CI tier or as a replacement for the CSS presence test in
`frontend/src/v2/__tests__/v2-layout-invariants.test.ts`. `CLAUDE.md`'s standing call is that the
Playwright CI layout tier is built when a second person is shipping UI regularly — until then this
is the manual habit, not a gate.

## What runs, and on which port

| Piece | Port | How |
| --- | --- | --- |
| MongoDB + PostgreSQL | 27017 / 5432 | `docker compose -f docker-compose.dev.yml up -d mongo postgres` |
| Backend (**after**) | **5050** | host process, `ts-node`, Node 20 |
| Frontend (**after**) | **3000** | `vite`, `REACT_APP_API_URL=http://localhost:5050` |
| Backend (**before**) | 5051 | same, from a scratch worktree at the base SHA |
| Frontend (**before**) | 3001 | same worktree |
| Capture | — | `scripts/ui-evidence-shot.mjs` (Playwright from the root `node_modules`) |

Two knobs decide whether anything renders:

- **The API base URL.** Served from `localhost`, the shell falls back to `http://localhost:5000`
  (`frontend/src/utils/apiBaseUrl.ts`) unless `REACT_APP_API_URL` is set at **build/config time**
  (`frontend/vite.config.ts` has an explicit `define` for exactly that name). On the machine this
  was written on port 5000 was free; on a machine with **AirPlay Receiver** enabled it is not.
  Using 5050 plus an explicit `REACT_APP_API_URL` is correct either way.
- **The origin allow-list.** CORS is `FRONTEND_URL`, comma-separated
  (`backend/server.ts:98` `buildAllowedOrigins`), default `http://localhost:3000`. **Every frontend
  port you serve must be in it.** A missing entry shows up as `Access to XMLHttpRequest … blocked by
  CORS policy` + `Network Error` + `net::ERR_FAILED` — which reads like a broken app, not a missing
  allow-list entry.

## 0. Create a local `.env`

**No `.env` is tracked in this repo — only `.env.example`.** Everything below sources a local
`.env`, for its database credentials and its local-login credentials, so the first step on a fresh
clone is to make one:

```bash
[ -f .env ] || cp .env.example .env      # never clobber an existing local .env
grep -E '^(PG_|LOCAL_DEV_LOGIN_|FRONTEND_URL|MONGO_URI)' .env
```

`.env.example` is where these actually live: `PG_USER=commonly` / `PG_PASSWORD=password`, the
`MONGO_URI` that matches the compose container (`commonly:commonly_dev@localhost:27017`),
`LOCAL_DEV_LOGIN_*`, and `FRONTEND_URL=http://localhost:3000`. **If you already have a `.env`,
do not overwrite it** — check it carries those values rather than copying over it.

## 1. Bring up the "after" revision

```bash
docker compose -f docker-compose.dev.yml up -d mongo postgres   # idempotent

cd backend
nohup bash -c 'set -a; . ../.env; set +a; \
  export PORT=5050 NODE_ENV=development \
    FRONTEND_URL="http://localhost:3000,http://localhost:3001" \
    SKILLS_CATALOG_PATH=/tmp/ui-harness-skills-index.json \
    MARKETPLACE_MANIFEST_PATH="'"$PWD"'/../packages/commonly-marketplace/marketplace.json"; \
  exec /Users/me/.local/node20/bin/node node_modules/.bin/ts-node --transpile-only server.ts' \
  > /tmp/ui-backend.log 2>&1 &

curl -s http://localhost:5050/api/health   # expect "status":"healthy" AND postgresql healthy
```

Four details in that block are load-bearing, each measured the hard way:

- **`. ../.env` first.** Your local `.env` (copied from `.env.example` in step 0) sets
  `PG_USER=commonly` / `PG_PASSWORD=password`, which is what the postgres container was initialised
  with. Passing the compose *defaults*
  (`postgres`/`postgres`) authenticates as a role that does not own the database: the API still
  answers, `/api/health` says `"status":"degraded"` with `password authentication failed for user
  "postgres"`, and chat-message paths quietly fail.
- **`FRONTEND_URL` = every origin you will serve** (see above).
- **`SKILLS_CATALOG_PATH` pointed at `/tmp`.** A local boot rewrites the skills index
  (`backend/services/skillsCatalogService.ts`); without this the run leaves
  `docs/skills/awesome-agent-skills-index.json` modified in your working tree.
- **Node 20** (`~/.local/node20/bin/node` here) for the backend and vite: the checkout's
  `node_modules` were installed with it, and the v26 on `PATH` breaks parts of the repo's tooling
  (34 of 369 unit suites die in `buffer-equal-constant-time` under it). The capture script is not
  one of those — see step 3.

```bash
cd frontend
nohup env REACT_APP_API_URL=http://localhost:5050 \
  /Users/me/.local/node20/bin/node node_modules/.bin/vite --port 3000 --strictPort \
  > /tmp/ui-vite.log 2>&1 &
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/v2/login   # 200
```

## 2. Sign in

`LOCAL_DEV_LOGIN_ENABLED=true` (set in `.env.example`, so present in your `.env` from step 0;
read at `backend/services/localDevLoginService.ts:44`) makes the backend create/refresh a local
login on boot: **`dev@commonly.local` / `password123`**. `scripts/ui-evidence-shot.mjs` logs in through
`POST /api/auth/login` and injects the JWT into `localStorage.token` **before the first
navigation**, which is where the shell reads it. No login-page step, so login flake can never
masquerade as a rendering failure. Rest of the local credential surface:
`docs/development/local-credentials.md`.

## 3. Capture one side

```bash
node scripts/ui-evidence-shot.mjs \
  --route /v2/pods/team/<podId> --out /tmp/after.png \
  --base-url http://localhost:3000 --api http://localhost:5050
```

Writes `/tmp/after.png` (full page) **and `/tmp/after.txt`** (`document.body.innerText`), then prints
the text length, its sha1, every non-2xx response and every console error. Playwright resolves
from the repo-root `node_modules`, so the script itself runs under either Node (measured under the
v26 on `PATH`); the **backend and vite** are the two that need Node 20.

**The `.txt` is the evidence; the PNG is the illustration.** A text-only agent cannot read a
screenshot — a `diff` of two `.txt` files is quotable in a PR body, and a 403 or a console error
names itself instead of looking like a layout bug.

### Flags the script enforces, and the two traps behind them

| flag | why it exists |
| --- | --- |
| `--width`, `--height` | a 390 shot is a **different layout**, not a smaller copy. Both default to 1440×900, and every run prints `viewport <w>x<h>@2x` so a capture names its own shape. |
| `--click '<selector>'` | some surfaces only exist after an interaction. The grant aside on `/v2/connectors` is rendered by clicking the row's **Manage**, so a shot named for the aside without the click captures the row list and calls it the aside. The click waits for the control to be visible and **throws with the selector named** if it never appears — same rule as an unknown flag: a capture that silently did something else is worse than no capture. |
| `UI_TOKEN=<jwt>` (or `--token <jwt>`) | `POST /api/auth/login` is rate-limited to **20 attempts per 15 minutes**. A pair is captured run by run, so a five-shot batch starts returning 429 and the page dumps `Failed to load chat room. Please try again.` — which reads like a broken revision, not a spent login budget. Pass a token the caller already holds and the script skips the login entirely (`auth token` vs `auth login` in the run line). **Prefer the environment form**: `--token <jwt>` puts the JWT in the process table (`ps`) where any same-user process reads it, and in shell history; `UI_TOKEN` is the same value through a channel that neither shows (`UI_TOKEN="$TOK" node scripts/ui-evidence-shot.mjs …`). |
| — | **an unknown flag is refused (exit 2), not ignored — and so are a value that belongs to no flag, a flag given twice, a flag given an empty value, and a flag with no value at all.** That is the defect this table was written for: the script had no `--width` at all, so `--width 390 --out x-390.png` wrote a silent 1440×900 capture under a `-390` name and the reviewer had no way to tell (2026-09-19). The rest are the same class one step over: `--width 390 400` used to run with 390 and never mention the 400; `--route=/v2/x?a=1&b=2` used to be cut at the second `=` into `/v2/x?a` and capture a different page; `--selector= "$SEL"` with `SEL` unset is an empty value, which the script treated as the flag being absent and silently captured the full page; and `--route $UNSET --out a.png` — a flag with no value — is the one path in this class that **invented** a value instead of dropping one, substituting the string `true` so the run navigated to a route literally named `true` under a file name that named the intended page (TASK-081). Check the run line: `viewport` and `auth` are printed on every capture for exactly this reason. |

**Check the `non-2xx` line for `/@fs/...woff2` 403s before comparing two revisions.** A worktree
whose `frontend/node_modules` is a **symlink** makes vite refuse to serve `/@fs/` font files, and
the page then renders in a fallback typeface — so the `before` and `after` PNGs differ in a way that
has nothing to do with the change under test (hit 2026-09-19; the fonts are not optional here, the
shell ships `@fontsource` faces). `cp -al` the real `node_modules` into every worktree that serves a
frontend; one symlinked tree against one copied tree is exactly the shape that hides it.

**A pair that is byte-identical is not automatically a null result.** Before calling a pair
vacuous, look for the element rather than the pixel: a `display: none` value still exists in the
DOM, so `document.body.innerText` (rendering-aware) drops it while `textContent` does not. On
`/v2/connectors` at 390 the audience line is hidden for live rows by `frontend/src/v2/v2.css`
(``.v2-connector-row__detail { display: none }`` under the phone breakpoint), so the `#1757` pair
is the *same PNG* at 390 while a DOM probe still reads the changed string — the fix is not lost on
mobile, it is simply not painted there. **Measure that, then say it, instead of shipping the
identical pair as evidence.**

Route shapes that cost time to rederive:

- `/v2/pods/<podType>/<podId>` — `<podType>` is the **real** pod type (`team`, `agent-room`, …),
  not the literal string `pod`. A wrong type renders the not-found shell with no error.
- The pod route renders the legacy `ChatRoom` (`frontend/src/v2/V2App.tsx` →
  `frontend/src/components/ChatRoom.tsx`). **The connector/integration cards live in that
  component's members sidebar** (~line 3452), not in a `V2*` component; `/v2/connectors` is the
  other surface that lists them.

### Capturing something that is below the fold — `--selector`

`fullPage: true` captures the whole *document*, and that is **not** enough for content
inside a panel with its own `overflow`. An inner scroller is still clipped to its own box,
so a full-page shot shows its first screenful no matter how tall the page is: two captures
of a trail that never scrolls look identical, and the evidence says nothing about the rows
the reviewer was asked to check. Name the subject instead:

```bash
node scripts/ui-evidence-shot.mjs \
  --route /v2/pods/team/<podId> --out /tmp/trail.png \
  --selector '.tools-trail' \
  --base-url http://localhost:3000 --api http://localhost:5050
```

The element is scrolled into view (walking ancestor scrollers, so the row inside the panel
is visible), then `/tmp/trail.png` is **that element's box** rather than the page. Two extra
artifacts come with it: `/tmp/trail.selector.txt` (`innerText` of the element — the quotable
half, and for a below-the-fold row the only half a text-only reader can use) and
`/tmp/trail.page.png` (the full page, so the scoped shot keeps its context). Without
`--selector` nothing changes: one full-page PNG and one `.txt`.

A selector that never appears **fails and writes nothing** (exit 1, message names the
selector) instead of shipping a screenshot of whatever was on screen — the failure mode that
makes an evidence capture worth less than no capture.

## 4. Capture the before/after pair

A screenshot of the changed revision alone proves nothing. Render the base beside it:

```bash
BASE=$(git rev-parse <base-sha>)
git worktree add --detach /tmp/ui-base "$BASE"
ln -sfn "$PWD/frontend/node_modules" /tmp/ui-base/frontend/node_modules
ln -sfn "$PWD/backend/node_modules"  /tmp/ui-base/backend/node_modules
```

Vite resolves those symlinked dependencies to paths **outside** the worktree, and its default
`server.fs.allow` (the workspace root) rejects them: the page renders with a **403 for every webfont
and asset**, so the two screenshots differ for a reason that has nothing to do with the change. Give
the worktree a harness-only config:

```ts
// /tmp/ui-base/frontend/vite.harness.config.ts  (untracked, scratch worktree)
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(base, defineConfig({
  server: { fs: { allow: ['/private/tmp/ui-base', '/Users/me/commonly'] } },
}));
```

Both paths are required: the worktree root (or `index.html` itself is refused) **and** the main
checkout (where the symlink points). On macOS `/tmp` is a symlink to `/private/tmp` and vite reports
the *resolved* path, so list the realpath or the dev server answers
`The request url "/private/tmp/ui-base/frontend/index.html" is outside of Vite serving allow list`.

Then run the base stack and capture both sides:

```bash
# sources the same local .env; the base worktree has none of its own
cd /tmp/ui-base/backend && nohup bash -c 'set -a; . /Users/me/commonly/.env; set +a; \
  export PORT=5051 NODE_ENV=development FRONTEND_URL="http://localhost:3000,http://localhost:3001" \
    SKILLS_CATALOG_PATH=/tmp/ui-harness-skills-index-base.json; \
  exec /Users/me/.local/node20/bin/node node_modules/.bin/ts-node --transpile-only server.ts' \
  > /tmp/ui-backend-base.log 2>&1 &

cd /tmp/ui-base/frontend && nohup env REACT_APP_API_URL=http://localhost:5051 \
  /Users/me/.local/node20/bin/node node_modules/.bin/vite --port 3001 --strictPort \
  --config vite.harness.config.ts > /tmp/ui-vite-base.log 2>&1 &

node scripts/ui-evidence-shot.mjs --route /v2/pods/team/<podId> --out /tmp/before.png \
  --base-url http://localhost:3001 --api http://localhost:5051

diff -u /tmp/before.txt /tmp/after.txt
```

**Pair the revisions end to end.** If the change is UI-only, one backend is enough and only the
frontend is swapped. If the change is API-visible, the **base frontend must talk to the base
backend** — otherwise both screens render the same payload and the pair proves nothing while looking
like a clean pass.

### Worked example — the connector card's routing state (#1731)

Viewer: a pod member who is **not** the integration's creator. That choice is the whole test — as the
creator you see everything in both revisions and the pair comes back identical.

```
$ diff -u /tmp/before.txt /tmp/after.txt      # base 5d067f45 -> head cda51208
 Telegram
 1 connected

-Chat -1001234567890
+Telegram chat connected

 Connected
 Add another
```

The same viewer's payload, `GET /api/integrations/<podId>`:

| Revision | `config.chatId` | `config.linkedUserId` | `config.linked` |
| --- | --- | --- | --- |
| base `5d067f45` | `"-1001234567890"` | `"6aace2…ae43"` | *(absent)* |
| head `cda51208` | *(absent)* | *(absent)* | `true` |

Two seeding steps this example needed, both of which the API refuses to do for you:

- **A connected connector.** `chatId` is server-owned routing state
  (`INTEGRATION_ROUTING_STATE_CONFIG_KEYS` in `backend/models/integrationPublicConfig.ts`), so
  `POST /api/integrations` strips it and the row stays `pending`. Seed it directly:
  `docker exec mongodb-dev mongosh "mongodb://commonly:commonly_dev@localhost:27017/commonly?authSource=admin" --quiet --eval 'db.integrations.updateOne({_id:ObjectId("<id>")},{$set:{"config.chatId":"-1001234567890",status:"connected"}})'`
- **A member viewer.** The connector list is membership-gated, so a non-member sees an empty panel
  and the "before" shot looks like the fix already landed:
  `db.pods.updateOne({_id:ObjectId("<podId>")},{$addToSet:{members:ObjectId("<userId>")}})`.

## Gotchas, by symptom

| Symptom | Cause | Fix |
| --- | --- | --- |
| Blank page, `net::ERR_FAILED`, `blocked by CORS policy` | frontend origin not in `FRONTEND_URL` | add the port to `FRONTEND_URL` and restart the backend |
| Every API call goes to `:5000` and fails | `REACT_APP_API_URL` not set when vite started | restart vite with it (it is baked in via `define`) |
| `/api/health` says `degraded`, postgres auth error | no local `.env` (it is untracked), or the compose defaults were used instead of its `PG_*` | `cp .env.example .env` (step 0), then `. ./.env` before starting the backend |
| 403s for `.woff2` under `/@fs/…` in a worktree | vite `server.fs.allow` excludes the symlink target | add both paths to `fs.allow` (realpath for `/tmp`) |
| `…/index.html is outside of Vite serving allow list` | allow-list entry is the symlinked `/tmp`, not `/private/tmp` | list the realpath |
| Panel/card renders empty | capture user is not a pod member | add the membership (above) |
| Both revisions render identically | wrong viewer (the creator sees everything), or a UI change captured against a shared backend when the change is API-visible | pick a viewer the change is *for*; pair backend revisions |
| Two captures look identical, or the row under test is missing from the shot | the content is inside a panel with its own `overflow`, and `fullPage` can't reveal it | re-shoot with `--selector` (above), and quote the `.selector.txt` |
| `docs/skills/awesome-agent-skills-index.json` shows as modified | the boot ran without `SKILLS_CATALOG_PATH` | `git checkout -- docs/skills/awesome-agent-skills-index.json` |

## Teardown

```bash
pkill -f 'ts-node --transpile-only server.ts'
pkill -f 'vite --port'
docker compose -f docker-compose.dev.yml down
git worktree remove /tmp/ui-base --force
git status --short          # expect clean: no modified skills index, no stray worktree files
```

## See also

- `frontend/src/utils/apiBaseUrl.ts` — API base resolution and the localhost fallback.
- `backend/server.ts:98` `buildAllowedOrigins` — the CORS allow-list.
- `backend/models/integrationPublicConfig.ts` — routing state that is stripped for non-owners.
- `.env.example` — the tracked template for the local `.env`; the `PG_*`, `MONGO_URI`,
  `LOCAL_DEV_LOGIN_*` and `FRONTEND_URL` values above come from here.
- `docs/development/local-credentials.md` — local logins and env flags.
- `playwright.config.ts` + `e2e/` — the repo's browser test tier (`E2E_BASE_URL`, `E2E_API_URL`);
  this harness is for one-off evidence, not for a suite.
- `docs/development/review-checklist.md` — the review rules a UI hold runs into.
