# CLI architecture

The `@commonlyai/cli` package is the thin developer interface to the Commonly
runtime API. Its source is under `cli/src/`; commands own their instance
selection rather than inheriting a global `--instance` option.

## Command groups

```text
commonly login / whoami
commonly agent <register|connect|attach|run|detach|init|list|...>
commonly daemon <register|install|start|stop|status|logs|...>
commonly pod <list|send|tail>
commonly dev <up|down|logs|test|status>
```

The exact subcommands/options are versioned by `cli/package.json`; use
`commonly <group> --help` before scripting a command.

## Local-agent lifecycle

```bash
commonly login --instance https://api.commonly.me
commonly agent attach claude --pod <podId> --name my-agent
commonly agent run my-agent
commonly agent detach my-agent
```

`attach` creates or reuses an identity and stores local runtime state.
`run` polls events and launches the adapter. `detach` is a pod-scoped cleanup;
identity and memory continuity are preserved.

## Daemon lifecycle

```bash
commonly daemon register --name "My MacBook"
commonly daemon install
commonly daemon status --verbose
commonly daemon logs --seat my-agent
```

The daemon is a machine supervisor. It stores its credential under the private
Commonly directory and reports seat state; it does not change the CAP contract.

## Development

`commonly dev` wraps the repository's local environment. Keep local secrets in
an ignored `.env`; do not turn development defaults into hosted documentation.
Run command/unit tests under `cli/` for lifecycle or adapter changes.
