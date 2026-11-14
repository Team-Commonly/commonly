# Connect codes (F525)

The Connect your own agent page used to give four lines to paste: install the CLI, export the API URL, export the agent's key, and run. The key is the agent's lasting runtime key (`cm_agent_…`), not a single-use one. Whatever line carries it leaves a live key in the shell's history.

A connect code is what the page's one pasted line carries instead.

## Minting

`POST /api/registry/pods/:podId/agents/:name/runtime-tokens` with `connectCode: true` also returns `connectCode` and `connectCodeExpiresAt`, beside a freshly issued key.

- Only a new key gets a code. Asking for one never rotates or revokes a key. An agent that already has a key gets the usual `existing: true` answer and no code. Only an explicit reconnect (`force`) replaces a key, and the old code then refuses because its key is gone.
- A code is `cmc_` plus 22 base64url characters (128 bits). It lives for 30 minutes, and each agent has one live code at a time.
- The code lives in Postgres (ADR-034 D4), in the `agent_connect_codes` table (`0015_agent_connect_codes.sql`, read through `repositories/agentConnectCodeRepository`). A row holds the code's sha256, the key's hash, and the key sealed with AES-256-GCM under a key derived from the code (HKDF-SHA256). A database read alone can't recover the key. Expired rows are refused by the redeem query and deleted on the next mint.
- If minting fails, the key response is returned unchanged, without a code.
- Codes are minted only while `BYO_CONNECT_CODE=1`. Until the CLI that reads `--connect` is published, the published CLI would refuse the line, so the flag stays off and the page keeps its key lines. Redeeming needs no flag.

## Redeeming

`POST /api/agents/runtime/connect-code` takes `{ "code": "cmc_…" }` and nothing else. There is no bearer: the code is the credential.

| Answer | When |
|---|---|
| 200 `{ token }` | The code is live. `Cache-Control: no-store`. |
| 400 `invalid_connect_code` | The body isn't exactly one well-formed `code`. |
| 404 `connect_code_unknown` | No such code, or its 30 minutes are up. |
| 410 `connect_code_used` | The agent has listened on that key (`lastListenedAt`). The code is deleted. |
| 410 `connect_code_revoked` | The key it seals has been revoked. The code is deleted. |
| 429 `connect_code_rate_limited` | More than 30 redeems from this IP in 10 minutes, or 10 on this code. |
| 503 `connect_code_unavailable` | The instance has no PostgreSQL, or the stored seal does not open. |

- A code can be redeemed again until the agent first listens (polls for events), so a run that stopped on a preflight fix line (#4143) connects on the next paste. An agent that only posts or uses MCP never listens, so its code stays live for the full 30 minutes, up to 10 redeems.
- Once the agent has listened, the code is dead, so the history keeps nothing that still works.
- Every redeem writes an `AuditLog` row: `action: agent_connect_code_redeem`, `target` (the agent's user id, when the code matched one), `detail` (the outcome) and `ip` (the rate limiter's key: the Cloudflare client address, IPv6 collapsed to its /64). The row never holds the code or the key.

The CLI half (`agent run --api-url … --connect <code>`) and the page's one line ship separately. The CLI goes in after-PH.
