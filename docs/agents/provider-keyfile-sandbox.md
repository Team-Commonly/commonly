# A confined seat's provider key file stays out of its sandbox (F453)

A seat with its own provider (the shared `provider` block: `id`, `baseURL`,
`keyFile`) that runs in a sandbox never holds its key. A provider proxy in the
CLI process reads `keyFile` outside the sandbox and adds the key to outbound
requests. That only works if the sandbox can't read the file too, so the CLI
refuses a key file the sandbox could read. The refusal happens at attach and on
every spawn, before anything starts.

**Nothing opens a refused key file, the CLI process included.** Every refusal
runs before the proxy reads the key, so the order stays honest if the proxy
later reads lazily or the file becomes readable.
`cli/__tests__/provider-proxy.refused-keyfile-never-opened.test.mjs` counts
opens of the key path, which must stay at 0. It also fails any open of that
path as unreadable, so a refusal that came after a read would show up as
`EACCES`.

## Where the check lives

Once, in the resolver every adapter already calls: `resolveProviderKeyFile` in
`cli/src/lib/provider-proxy.js`. It wraps the package's resolver
(`packages/seats/src/wire/provider-proxy.js`), which checks the file itself and
the workspace, and passes it the roots the sandbox can read. An adapter passes:

- `environment`, always.
- `sandboxed`, when its own rule for confinement isn't "public trust". dsh
  confines a private seat that declares `{ mode: 'workspace', network: {
  policy: 'restricted' } }`.
- `seatDirectories`: stable directories the adapter itself gives the sandbox.

`cli/__tests__/provider-proxy.adapter-wiring.test.mjs` pins that each adapter
with a shared provider block passes them. The list is fixed, so a new adapter
belongs there too.

| Spawn | Roots checked |
|---|---|
| Unconfined | none. Its shell can read the file anyway. |
| Confined on macOS | every `file-read*` / `file-read-data` grant in the Seatbelt baseline (`seatbeltSystemReadRoots`, parsed from the profile itself), for example `/etc`, `/private/etc`, `/opt/homebrew/lib`, `/usr/local/lib`, plus the seat directories. |
| Confined on Linux | bwrap's default read binds plus the seat's declared `read-outside` and `write-outside` (`bwrapReadRoots`), plus the seat directories. |

The legacy `internal` trust counts as public here, as it does everywhere else.

Seat directories per adapter:

| Adapter | Seat directories | Where |
|---|---|---|
| opencode (public) | its stable data home `~/.commonly/opencode-homes/<id>` | passed to the resolver |
| dsh (confined) | its stable home `~/.commonly/dsh-homes/<id>` | passed to the resolver |
| pi (public) | its seat home, pi's package, the CLI's code and prepared MCP builds | `refuseKeyFileInJail`, same comparison, before the proxy starts |
| goose, qwen | none needed: a fresh temp home per turn | |

Not covered yet: per-turn read-only binds an adapter adds beyond those, such as
opencode's optional `/usr/sbin` and `/sbin` on Linux, package directories and
MCP build directories in goose, qwen and dsh. These are root-owned or package
trees.

## How a path is compared

A key file is refused when a readable root is its directory or one of its
ancestors (a subpath), or is the file itself (a literal). Paths are compared as
written, through their real path (which covers a root that doesn't exist yet),
and by file identity (device and inode, as BigInt). So any spelling the file
system resolves to the same place is treated as that place.

The resolver also refuses a key file with more than one link. A second hard
link is the same file under a name the checks never see. The proxy re-checks
the link count when it opens the file.

BigInt matters on macOS. Inodes on the sealed system volume pass 2^53, and as
plain numbers `/usr` and `/usr/bin` round to the same value.

`cli/__tests__/provider-proxy.keyfile-spellings.smoke.test.mjs` runs under real
`sandbox-exec` and checks both sides: what the sandbox can read, and what the
resolver refuses.

## When the Seatbelt profile changes

`parseSeatbeltReadRoots` fails closed. If a read rule uses a filter it can't
turn into a root (`path`, `prefix`, `home-*`, or a regex not anchored at
`^/dev/`), it throws. A new kind of read grant then breaks the build instead of
silently opening a path the check never sees.
