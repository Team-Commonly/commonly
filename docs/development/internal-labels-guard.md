# Internal labels guard

This repo is public. A comment such as `// per D215` or "ruled by the Cofounder" points the reader at a record they can't open, so it explains nothing. Say the reason in plain words instead.

`.github/workflows/internal-labels-guard.yml` runs `scripts/check-internal-labels.mjs` on every PR that touches `backend/`, `cli/src/`, `frontend/src/`, `packages/` or `docs/`. It reads only the lines the PR adds, so labels already on main fail no one; those are being removed separately, one directory per PR.

## What it refuses

- **A ledger id:** `D` followed by two or three digits, D20 and up.
- **The internal role name** "Cofounder", in any case. In an ADR, write "the maintainers".

## What it lets through

- ADR decision numbers. They top out at D13 today, so anything below D20 passes, and so does "ADR-018 D12".
- Hex colours (`#D215AA`), cell references (`A1:D40`, `D$54`), and ids inside a word (`AD215B`).
- Vendored skills under `backend/commonly-bundled-skills/`.

If ADR decisions ever reach D20, raise `FIRST_LEDGER_ID` in the script.

## A real name that trips it

Add `<path> <token>` to `.internal-labels-allow`. The token is then allowed in that one file only.

## Run it locally

```bash
node scripts/check-internal-labels.mjs --base origin/main
node --test scripts/check-internal-labels.test.mjs
```
