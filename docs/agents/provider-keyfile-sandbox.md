# A public seat's provider key file stays out of its sandbox (F453)

A public seat with its own provider (the shared `provider` block: `id`,
`baseURL`, `keyFile`) never holds its key. A provider proxy in the CLI process
reads `keyFile` outside the sandbox and adds the key to outbound requests. That
only works if the sandbox can't read the file too, so the CLI refuses a key
file the sandbox could read, at attach and on every spawn, before anything
starts.

## Where the check lives

Once, in the resolver every adapter already calls: `resolveProviderKeyFile` in
`cli/src/lib/provider-proxy.js`. It wraps the package's resolver
(`packages/seats/src/wire/provider-proxy.js`) and passes it the roots the seat's
sandbox can read. An adapter gets the check by passing its environment
(`{ environment }`). `cli/__tests__/provider-proxy.adapter-wiring.test.mjs`
fails for an adapter that leaves the environment out.

| Seat | Roots checked |
|---|---|
| Not public (no `sandbox.trust`, or `workspace`) | none. The seat runs unconfined, and its shell can read the file anyway. |
| Public on macOS | every `file-read*` / `file-read-data` grant in the Seatbelt baseline (`seatbeltSystemReadRoots`, parsed from the profile itself), for example `/etc`, `/private/etc`, `/opt/homebrew/lib`, `/usr/local/lib`. |
| Public on Linux | bwrap's read binds: the default binds plus the seat's declared `read-outside` and `write-outside` (`bwrapReadRoots`). |

The legacy `internal` trust counts as public here, as it does everywhere else.

The workspace is always refused. Per-turn paths an adapter adds to the sandbox
belong to that adapter:

- pi checks its seat home and state through the same comparison
  (`refuseKeyFileInJail`).
- The others add a fresh temp directory, binaries and package directories.

## How a path is compared

A key file is refused when a readable root is its directory or one of its
ancestors (a subpath), or is the file itself (a literal). Either of two tests
refuses:

- **The path as written and through its real path.** This also covers a root
  that doesn't exist yet.
- **File identity: device and inode.** Seatbelt matches the path the kernel
  resolves, so a jailed process reads a granted file through any spelling of
  it. On this Mac that includes `/Users/x/KEYS/k` on a case-insensitive volume,
  and `/System/Volumes/Data/Users/x/keys/k` through the firmlink. Node's
  `realpathSync` keeps both spellings as typed. `realpathSync.native` fixes the
  case but not the firmlink. Identity catches every spelling of an existing
  path, plus symlinked directories and hard links, with no hand-written table.

Inodes are compared as BigInt. On the macOS sealed system volume they pass
2^53, and as plain numbers `/usr` and `/usr/bin` round to the same value.

`cli/__tests__/provider-proxy.keyfile-spellings.smoke.test.mjs` reads one key
file under real `sandbox-exec` through all three spellings, then checks that
the resolver refuses each one.

## When the Seatbelt profile changes

`parseSeatbeltReadRoots` fails closed. If a read rule uses a filter it can't
turn into a root (`path`, `prefix`, `home-*`, or a regex not anchored at
`^/dev/`), it throws. A new kind of read grant then breaks the build instead of
silently opening a path the check never sees.
