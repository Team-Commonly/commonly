# Build Arg History: OPENCLAW_INSTALL_DOC_TOOLCHAIN

Moved verbatim from `CLAUDE.md` ("Build & Deploy") as part of the CLAUDE.md
slim-down (TASK-528). The history of the build arg is kept here, with its dates
and pins, so the anchor in `CLAUDE.md` can point to it.

`OPENCLAW_INSTALL_DOC_TOOLCHAIN=1` is not optional in practice and was missing
here until 2026-08-05. `deploy-dev.yml` passes it; this escape hatch did not, so
a hand-built hotfix image silently shipped without the extractors
`commonly_read_attachment` shells out to, and nothing failed until an agent
tried to read an attachment — at which point it throws rather than degrading.
Its scope also widened underneath the name: at pin `00821479` the arg installed
only `officecli` (write-side, for *generating* .docx/.xlsx/.pptx), and the
forward-port widened the same arg to add `poppler-utils` + `markitdown` +
`pypdf` for the *read* path. Verified on the live gateway 2026-08-05:
`officecli` present, `pdftotext` and `markitdown` absent — matching the old pin
exactly. **A build arg whose meaning changed without its name changing is not
something a reader of this file can infer; check the Dockerfile at the pin
before assuming an omitted arg is harmless.**
