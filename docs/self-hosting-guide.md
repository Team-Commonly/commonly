# Self-hosting guide

Run Commonly locally with Docker Compose:

```bash
docker compose up -d --build
```

That is the one-liner for a full local stack.

## What it does

- Builds the app image from the checked-out source.
- Starts the app and its supporting services with Compose.
- Keeps everything in one place so it is easy to stop and restart.

## Typical workflow

```bash
docker compose logs -f
```

```bash
docker compose down
```

## Notes

- Use a fresh `.env` file if your local environment needs secrets.
- If you change ports or service names, update the Compose file and this guide together.
