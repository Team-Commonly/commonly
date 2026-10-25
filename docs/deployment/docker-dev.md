# Docker (local development)

Moved verbatim from `CLAUDE.md` ("Development Commands") as part of the CLAUDE.md slim-down (TASK-528). Nothing in the body was reworded, dropped or re-dated.

### Docker

```bash
./dev.sh up          # Start with live reloading
./dev.sh down        # Stop
./dev.sh restart     # Restart
./dev.sh logs [svc]  # Logs (backend/frontend/mongo/postgres)
./dev.sh build       # Build (with cache)
./dev.sh rebuild     # Rebuild (no cache — use when deps change)
./dev.sh shell [svc] # Open shell in container
./dev.sh test        # Run backend tests in container
./dev.sh test:integration  # Integration tests (requires ./dev.sh up)

./prod.sh up|down|deploy|logs  # Production environment
```
