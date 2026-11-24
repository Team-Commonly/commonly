# Staging on the prod VM

Staging is a second Compose project, `commonly-staging`, on the same VM as prod
(`docs/deployment/single-vm.md`). It costs nothing extra and is **stopped by
default**. Deploy Staging starts it for each merge to main, runs the smokes, posts
`staging-smoke`, and stops it. Walks and GIF reruns start and stop it the same way.

It runs **prod's own compose file** with one override on top
(`deploy/vm/staging/compose.staging.yml`), so every staging smoke also tests the
file prod runs.

## Layout on the VM

| Path | What |
|---|---|
| `/opt/commonly-staging` | Its own checkout. Never `/opt/commonly`, which is prod's; `staging.sh` refuses to run from there. |
| `deploy/vm/.env` | Staging's `.env`: image registry and tag, its own Postgres, Mongo and Redis passwords, the staging tunnel token, the journey invite code, the sink read token. Mode 0600. |
| `deploy/vm/backend.env`, `litellm.env` | Rendered once from the old GKE staging namespace (below). Mode 0600. |
| `deploy/vm/litellm/config.yaml` | Staging's LiteLLM config. |
| `deploy/vm/staging-secrets/` | The staging tunnel's `cloudflared.yml` (ingress) and `cloudflared-credentials.json`. Owned by uid 65532, the cloudflared image's non-root user, at mode 0400; root-owned 0600 makes the connector crash-loop on "permission denied". |
| `/usr/local/sbin/commonly-staging-ci` | `staging/ci-entry.sh`, installed root-owned. The only thing CI may run. |

Its volumes (`commonly-staging_postgres-data`, `commonly-staging_mongo-data`) and
network (`commonly-staging_commonly`) are its own. Nothing is published on a host
port. Prod's containers, volumes and network are never named.

## Why it can't hurt prod

- **Hard caps on every service** (`mem_limit`, `cpus`): about 3.3 GB and 1.9 CPUs
  at most in total, on an 8 GB, 2-CPU VM where prod uses about 2.3 GB.
- **`cpu_shares: 256`**, a quarter of prod's default weight, so prod wins any CPU
  contention 4:1.
- **`oom_score_adj: 500`**, so under memory pressure the kernel kills staging first.
- **Stopped by default.** `down` removes the containers. Nothing restarts on a VM
  reboot.
- **Its own tunnel.** It never uses prod's tunnel token.

Measured on the first boot (2026-11-24): all services healthy in about 4 minutes,
and VM memory available went from 5.7 GB to 4.6 GB while it ran.

## Commands (as root, from `/opt/commonly-staging/deploy/vm`)

```bash
sh staging/staging.sh up <8-char tag>   # pull, start, wait for health and /api/health/ready
sh staging/staging.sh journey           # one stranger journey against api-staging, mail read from the sink
sh staging/staging.sh status
sh staging/staging.sh down              # stop and remove containers; volumes kept; prune old staging images
```

A tag needs images for it: Deploy Staging builds `commonly-backend:<tag>`,
`commonly-bot:<tag>` and `commonly-frontend:<tag>-staging`.

## How Deploy Staging reaches it

The VM has no external address. The workflow authenticates to GCP through WIF
(trusted for `refs/heads/main` only), opens an IAP tunnel to port 22, and logs in
as `staging-ci` with a key held in the `STAGING_VM_SSH_KEY` secret. The host key is
pinned in `STAGING_VM_KNOWN_HOSTS`, and the instance and zone are the repo
variables `STAGING_VM_INSTANCE` and `STAGING_VM_ZONE`.

`staging-ci` can run one thing. Its `authorized_keys` line forces
`sudo /usr/local/sbin/commonly-staging-ci`, sudoers allows only that file (keeping
`SSH_ORIGINAL_COMMAND`), and the script accepts only `up <40-hex sha>`, `journey`,
`down` and `status`. `up` fetches main and refuses a SHA that is not on it, so even
a leaked key can only put a main commit on staging.

The CI service account holds `roles/iap.tunnelResourceAccessor` and
`roles/compute.viewer` on the VM instance only, which is enough to open the tunnel
and nothing more.

## First setup (done 2026-11-24; for a rebuild)

1. `git clone https://github.com/Team-Commonly/commonly.git /opt/commonly-staging`
2. Render the env files from a staging that still runs, with
   `render-env-from-k8s.sh --namespace <staging namespace>` (staging has no
   commonly-bot, so leave that target out), into a private directory. Write
   `.env` with fresh passwords and copy everything in at mode 0600.
3. Load the data: `pg_dump -Fc -n public` of the old staging Postgres, with the
   LiteLLM excludes from single-vm.md's "Restore for real", then `pg_restore` into
   this project's Postgres as in that section; `mongodump --archive --gzip` of the
   old staging Mongo, then `mongorestore --drop`. The first load had 22 Postgres
   tables, plus 72 Mongo collections with 521 users and 24 pods.
4. Install the CI entry and user:
   ```bash
   install -o root -g root -m 0755 staging/ci-entry.sh /usr/local/sbin/commonly-staging-ci
   useradd --system --create-home --shell /bin/sh staging-ci
   # /etc/sudoers.d/commonly-staging-ci (mode 0440):
   #   Defaults!/usr/local/sbin/commonly-staging-ci env_keep += "SSH_ORIGINAL_COMMAND"
   #   staging-ci ALL=(root) NOPASSWD: /usr/local/sbin/commonly-staging-ci
   # ~staging-ci/.ssh/authorized_keys (0600, owned by staging-ci):
   #   restrict,command="sudo -n /usr/local/sbin/commonly-staging-ci" ssh-ed25519 AAAA... deploy-staging
   ```
   Re-install `/usr/local/sbin/commonly-staging-ci` whenever `ci-entry.sh` changes.
   It runs from that copy, not the checkout.
5. **Only one connector may serve a tunnel's hostnames.** Two connectors on one
   tunnel split the traffic between them, so a smoke may hit either. Stop any other
   staging connector before the first VM `up`.
