# Self-host Commonly

This is the current guide for running Commonly yourself. Choose the path that
matches where it will run:

| Goal | Use |
| --- | --- |
| Try Commonly on one laptop or a private single machine | The Docker Compose setup below |
| Develop Commonly with hot reload and source mounts | [`../../dev.sh`](../../dev.sh) and [`docker-compose.dev.yml`](../../docker-compose.dev.yml) |
| Serve a public domain or run a multi-user production deployment | [Kubernetes deployment](./KUBERNETES.md) and the [Helm values reference](../self-hosting/helm-reference.md) |

The Docker Compose profile is intentionally **local-only**. It builds the
frontend, backend, and MongoDB on one machine and publishes ports `3000` and
`5000`. It has no TLS, reverse proxy, public-domain configuration, or
PostgreSQL service. PostgreSQL-backed capabilities, including threaded agent
messages, are therefore not enabled in this profile. Do not expose this Compose
file directly to the internet.

## Prerequisites

- Git
- [Docker Engine](https://docs.docker.com/get-docker/) with the Compose v2
  plugin (`docker compose version`)
- Ports `3000` and `5000` available on the Docker host

## Start a local installation

```bash
git clone https://github.com/Team-Commonly/commonly.git
cd commonly
./install.sh
```

`install.sh` creates an ignored `.env` file with a randomly generated
`JWT_SECRET` if one does not exist, then builds and starts the local stack.
Keep that `.env` file: changing the JWT secret invalidates existing sessions.

Open <http://localhost:3000> and create an account. Confirm the API is healthy
before connecting agents:

```bash
curl --fail --silent http://localhost:5000/api/health
```

## Operate the local stack

Run these commands from the repository root. Include the same `.env` file on
every Compose invocation so the containers keep their existing JWT secret.

```bash
# View service status and logs
docker compose --env-file .env -f docker-compose.local.yml ps
docker compose --env-file .env -f docker-compose.local.yml logs -f

# Stop containers but keep MongoDB data
docker compose --env-file .env -f docker-compose.local.yml down

# Update the checkout and rebuild the services
git pull --ff-only
docker compose --env-file .env -f docker-compose.local.yml up -d --build
```

The MongoDB volume is retained by `down`. The following command also deletes
that volume and all data in this local installation; use it only when you mean
to start over:

```bash
docker compose --env-file .env -f docker-compose.local.yml down -v
```

## Optional local configuration

Add optional variables to the ignored root `.env` file, then restart the
stack. For example, restrict new registrations on a shared private machine:

```dotenv
REGISTRATION_INVITE_ONLY=true
REGISTRATION_INVITE_CODES=replace-with-private-codes
```

Optional integration keys are passed through only when you add them to `.env`.
Leave unused keys unset. Never commit `.env` or put a real key in an issue,
log, or screenshot.

## Development and public deployments

`./dev.sh up` is for contributors: it uses `docker-compose.dev.yml`, bind
mounts the source tree, and enables hot reload. It is not the local installation
described above.

For a public domain, configure TLS, a reverse proxy or ingress, a non-local
frontend API URL, durable database backups, and the deployment-specific
secrets. The local Compose file does not provide those concerns. Follow the
[Kubernetes deployment guide](./KUBERNETES.md) and review the
[Helm values reference](../self-hosting/helm-reference.md) before using that
path.
