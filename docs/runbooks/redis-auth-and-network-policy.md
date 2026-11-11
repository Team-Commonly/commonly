# Redis auth and NetworkPolicy

## Redis AUTH (shipped)

Redis requires a password (`requirepass`) from every client. The password is
generated into GCP Secret Manager and delivered via ESO (`api-keys` →
`redis-password`), never committed or printed.

- Toggle: `redis.auth.enabled` — `false` in `values.yaml` (OSS chart + local dev
  run with no password), `true` in `values-dev.yaml` and `values-staging.yaml`.
- Redis loads `requirepass` from a generated `/tmp/redis.conf` (not
  `--requirepass`, so the password never appears in process args), hands off to
  `docker-entrypoint.sh` so it still drops to the `redis` user, and the
  `redis-cli` probes authenticate via `REDISCLI_AUTH`.
- Clients pass `password: redisPassword()` (undefined = no AUTH, so the auth-off
  path is unchanged). `config/redisPassword.ts` is the single source — it trims
  `REDIS_PASSWORD` so a stray trailing newline can't cause `WRONGPASS`. Clients:
  backend (socket.io adapter + health), ops-runner. litellm has no redis;
  commonly-bot has none.
- The generated password must be hex or alphanumeric (it goes into the conf
  unquoted) and must carry NO trailing newline. Create/rotate it with
  `printf '%s' "$(openssl rand -hex 32)" | gcloud secrets versions add
  <keyPrefix>redis-password --data-file=-`. A plain `echo … | --data-file=-`
  appends `\n`: Redis's conf tokenizer strips it so the server's effective
  password is the trimmed value, but a node-redis client would send it verbatim
  and get `WRONGPASS` (staging hit this 2026-11-04). The client trims
  defensively via `redisPassword()`, but keep the secret clean at the source.
- Rollout: one helm upgrade carries the Secret, redis `requirepass`, and every
  client's `REDIS_PASSWORD` together, with a brief adapter reconnect window.

## NetworkPolicy

Enforcement is already on in the dev cluster (the GKE Network Policy add-on,
Calico, on every node), so applying or deleting a policy restarts no pod and
takes effect within seconds. The rolling node recreation the add-on once
needed is paid. The trigger this section used to wait for has fired: Steel
runs in prod, and cloud-codex agents are templated.

**Egress (on, dev and staging):** `networkPolicy.egress.restrict` cuts the
GCE metadata address for every pod but the backup jobs
(`templates/network/egress-restrict.yaml`).

**Ingress (staging on, prod next):** `templates/network/ingress-allow.yaml`.
Each listening pod admits only its known clients, by pod label, on its own
port, and `default-deny-ingress` turns away everything else in the namespace:

| Pod | Admits | Port |
|---|---|---|
| frontend | the edge | 80 |
| backend | the edge; backend, backend-worker, commonly-bot, ops-runner, cloud-codex | 5000 |
| litellm | the same clients as backend; the edge only with `litellm.public` | 4000 |
| redis | backend, backend-worker, ops-runner | 6379 |
| mongodb (staging) | backend, backend-worker, ops-runner, the backup jobs | 27017 |
| email-sink (staging) | backend, backend-worker, the stranger journey | 8080 |
| agent-computer waker, steel gates | backend, backend-worker, ops-runner | 8080, 3000 |

The edge is `networkPolicy.ingress.edge`: staging's in-namespace tunnel, and
in prod the ingress-nginx controller. Every switch is its own value, so each
rollout step is one values flip. Turn the allows on before `defaultDeny`; an
allow does nothing until the deny exists.

- **Rollout:** staging first, all allows plus the deny, soaked 48 h across
  stranger-journey runs and staging smokes. Then prod one pod at a time
  (frontend and redis first), then prod's deny alone, in low traffic.
- **A new in-cluster client or Service** needs its allow in the same change.
  `scripts/verify-network-policy-chart.js` fails on any Service whose pods no
  allow admits on its port, and on any known flow that's refused.
- **Rollback:** `kubectl delete networkpolicy default-deny-ingress -n <ns>`
  restores everything in seconds. Then flip `defaultDeny.enabled` off, or the
  next deploy puts it back.
- **Probing it:** run acceptance probes from a dev-pool pod. On spot nodes the
  GKE metadata server answers 169.254 addresses, so a probe there proves
  nothing about egress.

See the in-cluster service-auth audit (SRE, 2026-11-04) for the full inventory.
