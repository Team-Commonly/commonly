# Lint Gate State

Moved verbatim from `CLAUDE.md` ("Linting") as part of the CLAUDE.md slim-down
(TASK-528). The measured table and the burn-down note were not reworded. The
counts are a snapshot from the date in the text, not a live measurement.

**`npm run lint` is not a green command, and has not been for some time.** Only
part of it is gated. What is actually enforced, measured 2026-08-28 at
`ccacf0235`:

| scope | state | gated? |
|---|---|---|
| backend `.ts` (310 files) | **0 errors** | CI (`Backend TypeScript lint`) + `lint-staged` |
| backend `.js` (282 dirty, 277 under `__tests__`) | 2,279 errors | no |
| cli | 0 errors | CI (`Run CLI lint`) |
| frontend (199 `.ts`/`.tsx`, 3 `.js`) | **unmeasured in CI** — 17 errors / 160 warnings reported 2026-08-29 | no (errors gated since 2026-11-24, see below) |

The frontend row says *no* rather than `lint-staged` because that glob is
`frontend/src/**/*.{js,jsx}` and matches **3** `__mocks__` stubs against 199
`.ts`/`.tsx` — stale to zero exactly the way the backend globs were, one
directory over. And `npm run lint` is `lint:cli && lint:backend &&
lint:frontend`, so while the backend leg is red the frontend leg **never
executes**; that error count came from running eslint directly, not from the
script. The clean-checkout blocker once reported here is gone: `npm ci
--dry-run` succeeds in `frontend/` (measured 2026-09-23), and the `@dicebear/*`
packages it named were removed with Commonly's own avatar kit. The dead glob
still belongs to the burn-down.

Backend `.ts` reaches zero because 48 rules that fire on existing code are
parked in `backend/.eslintrc.js` with their counts — 2,127 errors, 72%
auto-fixable. Everything else in `airbnb-base` stays ON, so the gate catches
the first NEW violation of any of several hundred rules. Re-enabling the parked
48 and fixing the `.js` corpus is the burn-down task; do not describe either as
green until it is done.

## Frontend errors gated (2026-11-24)

Measured on main before the change: 532 files, **134 errors, 379 warnings**.
The errors were 96 `import/first` in 19 tests and 38 `i18next/no-literal-string`.
The import errors were a `jest.mock` or a `TextEncoder` polyfill written above the
imports. babel-jest hoists `jest.mock` either way, and babel orders the
polyfill after every import already, so the fix moves the lines and changes
nothing at runtime. Of the 38 literal strings, 37 were props or option keys
the rule did not know were not text: `kind`, `tone`, `seed`, `separator`, an
option's `value`, and the inspector's `renderGroup` ids. They are now in the
rule's exclude lists. The one real string was the landing badge's alt. It
repeats the badge image's own English text, so it carries a disable with
that reason.

Now gated:

- The `Frontend tests` job runs `eslint src --ext .js,.jsx,.ts,.tsx --quiet`,
  so any new frontend lint error fails CI. Warnings are not gated yet: 325 of
  the 379 are `react/jsx-filename-extension` on `.tsx`.
- The `lint-staged` frontend glob is `frontend/src/**/*.{js,jsx,ts,tsx}`, so
  the pre-commit hook covers TypeScript too. It used to match only three
  `__mocks__` stubs.

Still not gated: the backend `.js` corpus (mostly `__tests__`). Root
`npm run lint` still stops at the backend leg.
