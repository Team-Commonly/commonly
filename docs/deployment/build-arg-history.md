# Build Arg History: OPENCLAW_INSTALL_DOC_TOOLCHAIN

> **Historical.** This describes the gateway image, which was retired and is no longer built ([ADR-021 Part B](../adr/ADR-021-pi-turn-engine-and-openclaw-retirement.md)).

Moved verbatim from `CLAUDE.md` ("Build & Deploy") as part of the CLAUDE.md
slim-down (TASK-528). The history of the build arg is kept here, with its dates
and pins, so the anchor in `CLAUDE.md` can point to it.

`OPENCLAW_INSTALL_DOC_TOOLCHAIN=1` was not optional in practice and was missing
here until 2026-08-05. `deploy-dev.yml` passes it; this escape hatch did not, so
a hand-built hotfix image silently shipped without the extractors
`commonly_read_attachment` shells out to, and nothing failed until an agent
tried to read an attachment — at which point it threw rather than degrading.
Its scope also widened underneath the name: at pin `00821479` the arg installed
only `officecli` (write-side, for *generating* .docx/.xlsx/.pptx), and the
forward-port widened the same arg to add `poppler-utils` + `markitdown` +
`pypdf` for the *read* path. Verified on the live gateway 2026-08-05:
`officecli` present, `pdftotext` and `markitdown` absent — matching the old pin
exactly. **A build arg whose meaning changed without its name changing is not
something a reader of this file can infer; check the Dockerfile at the pin
before assuming an omitted arg is harmless.**

## The backend image's OfficeCLI pin (removed 2026-11-11, F408)

The backend image installed `officecli` 1.0.70, pinned by version and by the
release's SHA-256 for each architecture (x64 `654a4a9e…`, arm64 `4a4a8d7c…`),
with the GitHub API asset endpoint as a fallback when `releases/download`
answered 504 (seen twice on 2026-11-09). Its only caller in the backend was the
PPTX preview route, retired in #3878 (F405). After that nothing in the backend
image ran it: the native runtime has no shell tool, and the bundled `officecli`
skill runs in agent runtimes. F408 removed the binary, its build args
(`OPENCLAW_OFFICECLI_VERSION`, `OFFICECLI_SHA256_*`, `OFFICECLI_ASSET_ID_*`)
and the download step. No workflow passed those args, so nothing else changed.
To bring it back, restore the block from the backend `Dockerfile` at the commit
before F408.
