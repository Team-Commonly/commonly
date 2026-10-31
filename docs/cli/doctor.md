# `commonly doctor` and the stale-CLI notice

TASK-660, from D213: the Node daemon stays, and install gets harder to break
silently by making breakage visible. Code: `cli/src/lib/doctor.js` (checks),
`cli/src/commands/doctor.js` (host wiring), `cli/src/lib/update-check.js`
(notice). Tests: `cli/__tests__/doctor.test.mjs`, `cli/__tests__/update-check.test.mjs`.

## The checks

`commonly doctor [--instance <keyOrUrl>]` prints one line per check: `pass`,
`fail` (with a `fix:` command) or `skip`. It exits 1 when any line fails, else 0.

| Line | What it checks | Fails when |
|------|----------------|------------|
| `node` | Node against `engines.node` in the CLI's package.json | Node is below the floor |
| `install` | The first `commonly` on PATH and its `--version`; notes when the doctor you ran is a different version, or more copies are on PATH | none on PATH, or it does not answer `--version` |
| `login` | The saved instance (active, or `--instance`) and the user its token belongs to, via `GET /api/auth/user`. The token is sent, never printed. | not logged in, no token, token rejected, or the instance cannot be reached in 5 s |
| `daemon` | The daemon record, its launchd/systemd service file, and the server's view (`online`, last heartbeat) | the record is unreadable or insecure, the service is not installed, the key is revoked, or the machine is offline. **Skips** when no daemon is registered: foreground agents are a supported setup. |
| `adapter:<name>` | One line per adapter that an agent in `~/.commonly/tokens/` uses: the adapter's own `detect()`, which runs `<cli> --version` | the CLI is missing or fails `--version`, the adapter is unknown, or the token file records none |
| `macos-claude` | On macOS, when an agent uses the claude adapter: `sandbox-exec` runs, and `~/Library/Keychains/login.keychain-db` and `/usr/bin/security` exist | any of the three is missing |

The macOS check only **stats** the two files. It never runs `security`, so it
cannot prompt, unlock or read a keychain item.

## The stale-CLI notice

`agent run` and `daemon run` print one line at start-up when the installed CLI
is 3 or more patch releases behind npm latest, or behind a newer minor or major:

```
<ts> [<agent>] your CLI is 42 versions behind (installed 0.1.168, latest 0.1.210). Update: npm install -g @commonlyai/cli@latest (silence with COMMONLY_NO_UPDATE_CHECK=1)
```

- **Never blocks start-up.** The check is fired, not awaited; the first poll
  goes out before it answers.
- **2 s cap** on the registry lookup, enforced by its own timer.
- **24 h cache** in `~/.commonly/update-check.json`; only a successful lookup is cached.
- **Silent** when offline, on a registry error, or with `COMMONLY_NO_UPDATE_CHECK=1`.
- The threshold is `UPDATE_NOTICE_MIN_BEHIND` (3). One or two releases behind
  is the normal gap between a publish and a seat's next restart.
- **Trap: a source checkout reads as stale.** `.github/workflows/npm-publish.yml`
  stamps the version into its working copy only (`npm version
  --no-git-tag-version`), so `cli/package.json` on main lags npm: 0.1.168 on
  main against 0.1.210 published, 2026-10-31. Run from a checkout and you get
  the notice, so set the opt-out. A seat on a pinned `~/.commonly/cli-<version>/`
  install reads its real published version.
