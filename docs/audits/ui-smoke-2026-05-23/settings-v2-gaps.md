# V2 Settings/Config — Gap Audit (2026-05-23)

Source: subagent `Explore` audit of v2 settings routes + legacy UserProfile + backend admin/pod/integration endpoints.

## TL;DR

**V2 Settings just wraps the legacy `UserProfile` MUI component.** Account-only flows are covered (profile, avatar, email, API token); admin-only flows partially wrapped (users list, GlobalIntegrations). Everything else — **pod members, pod integrations, pod roles, password change, 2FA, agent presets** — has no v2 surface, even though most of the backend APIs are in place.

## Surface inventory (abridged)

| Category | Surface | Legacy | V2 | API | Status |
|---|---|---|---|---|---|
| Account | profile/avatar/email/displayName | ✅ | ✅ (wrapped) | `PUT /api/users/profile` | Complete |
| Account | API token | ✅ | ✅ (wrapped) | `POST /api/auth/api-token/generate` | Complete |
| Account | Password change | ❌ | ❌ | none | **P1 gap** |
| Account | 2FA / MFA | ❌ | ❌ | none | **P1 gap** |
| Pod | Members | ✅ legacy | ❌ | `POST/DELETE /api/pods/:podId/members*` | **P0 gap** |
| Pod | Roles/permissions | ✅ legacy | ❌ | `PATCH /api/pods/:podId/members/:userId` | **P0 gap** |
| Pod | Pod-scoped integrations | ✅ legacy | ❌ | `/api/integrations/*` | **P1 gap** |
| Pod | SOUL / Heartbeat editing | ❌ | ❌ | read-only in `config.soul/heartbeat` | **P1 gap** |
| Pod | Retention | ❌ | ❌ | none | **P2 gap** |
| Admin | Users list | ✅ | ✅ (wrapped) | `/api/admin/users` | Complete |
| Admin | Invitations | ✅ legacy | ❌ | `/api/admin/users/invitations*` | **P1 gap** |
| Admin | Waitlist | ✅ legacy | ❌ | `/api/admin/users/waitlist*` | **P1 gap** |
| Admin | Global integrations | ✅ legacy | ✅ (wrapped) | `/api/admin/integrations/*` | Wrapped, unchanged |
| Admin | Agent autonomy | ❌ | ❌ | endpoints exist but not wired | Not implemented |
| Admin | Audit logs | ❌ | ❌ | none | **P2 gap** |
| Agent | Skills attach/detach per agent | ✅ legacy | ❌ | `/api/agents/:id/skills` (read-only GET) | Incomplete |
| Agent | Presets / customizations | ✅ legacy | ❌ | reprovision-all bulk only | **P1 gap** |
| Agent | Runtime config | ❌ | ❌ | opaque | **P2 gap** |
| Agent | Memory | ❌ | ❌ | MCP-only | **P2 (kernel boundary)** |

## P0 + P1 highlights

- **Pod member management** — no v2 UI to add/remove/list pod members; backend exists.
- **Pod roles** — same shape, no v2 UI.
- **Password change & 2FA** — backend doesn't exist either; security gap.
- **Pod integrations** — backend per-pod integrations route exists, no v2 surface.
- **Pod SOUL / Heartbeat editing** — read-only; no admin override path in UI.

## Recommendation: minimal v2 Settings hub

Three-part Settings (don't break the `/v2/settings → UserProfile` escape hatch):

1. **Account panel** — current UserProfile in v2 tokens + add password-change modal + 2FA modal.
2. **My Pods** — pod-card grid; clicking opens a slide-over inspector with tabs: Members (add/remove/roles), Integrations, Settings (retention, SOUL for agent-rooms).
3. **Admin Console** — tabs for Users, Invitations, Waitlist, Global Integrations, Audit. Reuses existing components.

Delivery: Phase 1 (account security + My Pods member mgmt, 2–3 days), Phase 2 (pod integrations + SOUL editing, 1–2 days), Phase 3 (admin waitlist/invite tabs, 1 day).

No backend changes for the pod and admin tracks. Password/2FA needs both.
