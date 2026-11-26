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
| `deploy/vm/.env` | Staging's `.env`: image registry and tag, its own Postgres, Mongo and Redis passwords, the journey invite code, the sink read token, and placeholder `BACKUP_S3_*` and `TUNNEL_TOKEN` values. The prod file requires those last two with `${VAR:?}` even for services staging switches off, and the override blanks `TUNNEL_TOKEN` before it reaches cloudflared. Mode 0600. |
| `deploy/vm/backend.env`, `litellm.env` | Rendered once from the old GKE staging namespace (below). Mode 0600. |
| `deploy/vm/litellm/config.yaml` | Staging's LiteLLM config. |
| `deploy/vm/staging-secrets/` | The staging tunnel's `cloudflared.yml` (ingress) and `cloudflared-credentials.json`. Owned by uid 65532, the cloudflared image's non-root user, at mode 0400; root-owned 0600 makes the connector crash-loop on "permission denied". |
| `/usr/local/sbin/commonly-staging-ci` | `staging/ci-entry.sh`, installed root-owned. The only thing CI may run. |

Its volumes (`commonly-staging_postgres-data`, `commonly-staging_mongo-data`) and
network (`commonly-staging_commonly`) are its own. Nothing is published on a host
port. Prod's containers, volumes and network are never named.

## Why it can't hurt prod

- **Hard caps on every service** (`mem_limit`, `cpus`): about 3.3 GB and 1.2 CPU
  at most in total (caps of 1.0 starved LiteLLM's boot on 2026-11-26; caps totalling 1.9 CPUs still let a staging deploy
  push prod's event-loop lag past 1.5 s on 2026-11-26), on an 8 GB, 2-CPU VM where prod uses about 2.3 GB.
- **`cpu_shares: 256`**, a quarter of prod's default weight, so prod wins any CPU
  contention 4:1.
- **`oom_score_adj: 500`**, so under memory pressure the kernel kills staging first.
- **Stopped by default.** `down` removes the containers, and every service has
  `restart: "no"`, so nothing comes back after a VM or Docker restart.
- **Logs capped** at 10 MB x 3 per container, like prod's.
- **Its own tunnel.** The connector joins only the tunnel its credentials file
  names: the override blanks `TUNNEL_TOKEN`, which would otherwise outrank the file.
- **One verb at a time.** `staging.sh` holds `/run/commonly-staging.lock`, so a
  merge's `down` waits for a walk's run to finish rather than cutting it off. The CI
  entry takes the same lock before its first git operation, so two overlapping `up`s
  can't share a fetch.
- **A status vouches only for what was tested.** The smokes run in separate ssh
  sessions, so before posting `staging-smoke` the workflow reads `status` and posts
  success only if staging is still at its tag. Its final `down <tag>` leaves staging
  up if another run has moved it on.

Measured on the first boot (2026-11-24): all services healthy in about 4 minutes,
and VM memory available went from 5.7 GB to 4.6 GB while it ran.

## Commands (as root, from `/opt/commonly-staging/deploy/vm`)

```bash
sh staging/staging.sh up <8-char tag>   # pull, start, wait for health and /api/health/ready
sh staging/staging.sh journey           # one stranger journey against api-staging, mail read from the sink
sh staging/staging.sh status            # `tag <tag>`, then the containers
sh staging/staging.sh down [<tag>]      # stop and remove containers; volumes kept; prune old staging images.
                                        # With a tag, only if staging is still at it.
```

A tag needs images for it: Deploy Staging builds `commonly-backend:<tag>`,
`commonly-bot:<tag>` and `commonly-frontend:<tag>-staging`.

## How Deploy Staging reaches it

The VM has no external address. The workflow authenticates to GCP through WIF
(trusted for `refs/heads/main` only), opens an IAP tunnel to port 22, and logs in
as `staging-ci` with a key held in the `STAGING_VM_SSH_KEY` secret. The host key is
pinned in `STAGING_VM_KNOWN_HOSTS`, as one line keyed `[localhost]:2222` (the
tunnel's local end), and the instance and zone are the repo
variables `STAGING_VM_INSTANCE` and `STAGING_VM_ZONE`.

`staging-ci` can run one thing. Its `authorized_keys` line forces
`sudo /usr/local/sbin/commonly-staging-ci`, sudoers allows only that file (keeping
`SSH_ORIGINAL_COMMAND`), and the script accepts only `up <40-hex sha>`, `journey`,
`down [<tag>]` and `status`. `up` fetches main and refuses a SHA that is not on it, so even
a leaked key can only put a main commit on staging. Note what that still means:
`staging.sh` and the compose files come from the commit being deployed and run as
root, so anything merged to main can run as root on the prod VM through this path.
That is the same trust main already has over prod's images.

A run that a newer push supersedes while it is still queued posts no
`staging-smoke` status, so that SHA cannot be rolled to prod; roll the newer one.

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
5. Install the staging slice, which every staging container joins through
   `cgroup_parent` (added 2026-11-26):
   ```bash
   printf '[Unit]\nDescription=Commonly staging stack\nBefore=slices.target\n\n[Slice]\nCPUWeight=10\n' \
     > /etc/systemd/system/staging.slice
   systemctl daemon-reload && systemctl start staging.slice
   ```
   It sits at the top level, beside `system.slice` (weight 100), which holds prod's
   containers. Two traps, both verified on the VM:
   - **Install it before the first `up`.** With the unit missing, Docker's systemd
     driver still places containers in a slice of that name, but systemd creates it
     with the default weight of 100. That removes the protection without any error.
   - **Keep the name free of dashes.** systemd reads `a-b.slice` as a child of
     `a.slice`. A first try named `commonly-staging.slice` landed under an implicit
     `commonly.slice` at weight 100, a top-level peer of all of `system.slice`. That
     would have made staging stronger, not weaker.

   To check, start staging and read `/sys/fs/cgroup/staging.slice/cpu.weight`, which
   should be 10, and confirm the staging scopes are listed under that directory.
   The `cpu.weight` file can be missing while the slice is empty.
6. **Only one connector may serve a tunnel's hostnames.** Two connectors on one
   tunnel split the traffic between them, so a smoke may hit either. Stop any other
   staging connector before the first VM `up`.
