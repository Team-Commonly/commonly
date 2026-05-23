# V2 UI Walkthrough — 2026-05-23 (local stack)

Env: `./dev.sh up` on macOS, fresh smoke-admin user (no admin role), 0 LLM creds in `.env`.

## What worked (no console errors)

- **`/` landing renders** clean (1 favicon 404 + 2 React Router future-flag warnings — benign).
- **Login** at `/login` → `/feed` (legacy default, not `/v2` — finding).
- **`/v2` mount** is clean. Empty pod list, empty inspector, 4-tab nav rail (Pods, Agents, Apps, Settings).
- **New Pod inline form** creates pod, lands on `/v2/pods/<id>` with composer, attach-file, send button, mention hint. Header shows pod team button + invite button.
- **Send message** works (`POST /api/messages/<podId>` 200), renders in chat with avatar + handle + timestamp.
- **Your Team (`/v2/agents`)** auto-installs Commonly Bot into new pod (Native runtime); shows "1 agent working across 1 project" + "+ Hire an agent".
- **Hire an agent (`/v2/agents/browse`)** — 3 tabs (Discover, Presets 33, Installed), 5 visible installables (Pod Welcomer, Task Clerk, Pod Summarizer, Cuz 🦞, +1). Install dialog has Instance name, ID, Runtime gateway radio, LLM credentials radio, pod multi-select, Cancel/Install. **Admin-only fields gracefully degrade** ("Gateway selection is available to global admins").
- **Install flow** auto-creates 1:1 agent-room + posts a templated welcome message in the selected pod. Lands you in the agent-room.
- **Agent-room empty state** is spot-on: "Say hi to Pod Welcomer" + 3 chip suggestions. (Chip click fills composer, doesn't auto-send.)
- **Message send to agent-room** enqueues `chat.mention` event via `agentEventService` correctly. (Reply never lands — no LLM creds locally.)

## V2 surface map (what each tab is)

| Tab | Route | Renders | State |
|---|---|---|---|
| Pods | `/v2` and `/v2/pods/:id` | Pod sidebar + chat + composer | Polished |
| Agents | `/v2/agents` and `/v2/agents/browse` | "Your Team" + install browse | Polished |
| Apps | `/v2/marketplace` | Marketplace browse | **Broken — hits wrong endpoints** |
| Settings | `/v2/settings` | UserProfile (legacy MUI wrapped) | Account-only |

## Findings

### P0
1. **Apps button routes to /v2/marketplace** but the marketplace page hits `/api/apps/marketplace?` and `/api/apps/marketplace/featured` (legacy shadows). The shipped `/api/marketplace/browse` is never called. **Discover and Installed counts are both 0** even after installing 1 agent. Result: marketplace browse is functionally dead for v2.
2. **Default post-login route is `/feed` (legacy)**, not `/v2`. New users land in the legacy shell first. The v2 nav rail isn't visible until they manually navigate to `/v2`.

### P1
3. **Chip click in agent-room empty state fills composer but doesn't auto-send.** UX expectation: clicking a suggested prompt should send it. Right now it requires a second action (Enter / Send button). Surfaced as friction for the hero "first DM" flow.
4. **Settings has 3 tabs only (Overview / Apps / API Token).** No password change, no 2FA, no admin sub-page (even though user is admin), no pod settings entry. Matches the subagent gap audit.
5. **Apps tab label vs route mismatch.** Nav rail says "Apps", landing page heading says "Marketplace". Pick one.

### P2
6. **"Apps Marketplace" link inside Agent Hub** points to `/apps` (legacy), not `/v2/marketplace`. Cross-references the legacy shell from within v2.
7. **`+1` agent in browse** has no Install button visible — could be intentional (already installed?) but unclear from the card.

## Network sanity

184–271 `/api/*` requests during the run. **All 2xx.** No 4xx/5xx surfaced in the walkthrough. The "wrong endpoint" issue is silent — `/api/apps/marketplace?` returns 200 with an empty list.

## Local deploy path verdict

✅ Frontend + backend + mongo + postgres + WebSocket fanout + chat post + native-install registry all functioning. Local deploy path is **working**; the only gap is LLM creds, which is `./dev.sh restart` away once we wire LITELLM_API_KEY into `.env`.
