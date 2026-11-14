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
| email-sink (staging) | backend, backend-worker, ops-runner, the stranger journey | 8080 |
| agent-computer waker, steel gates | backend, backend-worker, ops-runner | 8080, 3000 |

The edge is `networkPolicy.ingress.edge`: staging's in-namespace tunnel, and
in prod the ingress-nginx controller. Every switch is its own value, so each
rollout step is one values flip. **An allow takes effect alone:** a policy
that selects a pod closes it at once to every client the policy doesn't list,
deny or no deny. So each allow is a cutover for its pod, and `defaultDeny`
closes only the pods no allow names. A policy that admits the edge refuses to
render while `edge` is empty, because an empty `from` admits every source.

- **Rollout:** staging first, all allows plus the deny, soaked 48 h across
  stranger-journey runs and staging smokes. Then prod one pod at a time
  (frontend and redis first), then prod's deny alone, in low traffic.
- **Prod step 1 (`values-dev.yaml`):** `allow-frontend-ingress` (the
  ingress-nginx controller only) and `allow-redis-ingress` (backend,
  backend-worker, ops-runner), no deny. Checked live, read-only, 2026-11-11:
  - the controller's pods carry `app.kubernetes.io/name=ingress-nginx` and
    `app.kubernetes.io/component=controller`, in the namespace labelled
    `kubernetes.io/metadata.name=ingress-nginx`, and don't use the host network;
  - the Cloudflare tunnel in that namespace dials the controller's Service,
    never frontend, so the edge names the controller's pods, not the namespace
    (the verifier refuses a namespace-wide edge);
  - the dev workloads that name redis are exactly those three.
- **Prod step 2 (`values-dev.yaml`):** `allow-agent-computer-waker-ingress`
  and `allow-agent-computer-steel-ingress` (backend, backend-worker,
  ops-runner), still no deny. It rolls only after step 1 is live with its pods
  Ready, so kubelet probes are known to pass a selecting policy. Checked
  live, read-only, 2026-11-14:
  - the waker pod carries `app=agent-computer-waker` and each gate
    `app=agent-computer-steel`, neither with a `component` label, behind
    Services on 80 (to 8080) and 3000;
  - their one caller is the broker in the backend
    (`agentComputerBroker.ts`: the waker's `/v1/users/:id/wake`, then steel);
    the waker scales `steel-<userId>` through the kube API and never calls a
    gate over HTTP;
  - no Ingress or route names either, so the edge admits neither;
  - ops-runner is on the list on purpose: it carries the broker's env and
    the steel token, so an operator script can drive a gate. Removing it
    would break that path, not tighten anything the token doesn't already
    decide.
- **A new in-cluster client or Service** needs its allow in the same change.
  `scripts/verify-network-policy-chart.js` fails on any Service whose pods no
  allow admits on its port, and on any known flow that's refused.
- **Rollback:** deleting `default-deny-ingress` reopens only the pods no allow
  names; every allow still fences its own pod. To reopen one pod, delete its
  allow (`kubectl delete networkpolicy allow-<name>-ingress -n <ns>`). To reopen
  the namespace, delete the deny and every `allow-*-ingress` policy. Either
  takes effect in seconds; then flip the matching switches off, or the next
  deploy puts them back. Leave `egress-restrict` alone: it is not part of this.
- **Probing it:** run acceptance probes from a dev-pool pod. On spot nodes the
  GKE metadata server answers 169.254 addresses, so a probe there proves
  nothing about egress.

See the in-cluster service-auth audit (SRE, 2026-11-04) for the full inventory.
