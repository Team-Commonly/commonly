# Lint Gate State

Moved verbatim from `CLAUDE.md` ("Linting") as part of the CLAUDE.md slim-down
(TASK-528). The measured table and the burn-down note were not reworded. The
counts are a snapshot from the date in the text, not a live measurement.

**Since 2026-11-24 `npm run lint` exits 0, and CI gates errors in every leg**
(see the sections below). Before that it was not a green command. The table
and the two paragraphs after it are the 2026-08-28 measurement at `ccacf0235`,
kept as history:

| scope | state | gated? |
|---|---|---|
| backend `.ts` (310 files) | **0 errors** | CI (`Backend TypeScript lint`) + `lint-staged` |
| backend `.js` (282 dirty, 277 under `__tests__`) | 2,279 errors | no (errors gated since 2026-11-24, see below) |
| cli | 0 errors | CI (`Run CLI lint`) |
| frontend (199 `.ts`/`.tsx`, 3 `.js`) | **unmeasured in CI** — 17 errors / 160 warnings reported 2026-08-29 | no (errors gated since 2026-11-24, see below) |

As of 2026-08-28, the frontend row said *no* rather than `lint-staged` because
that glob was `frontend/src/**/*.{js,jsx}` and matched **3** `__mocks__` stubs
against 199 `.ts`/`.tsx` — stale to zero exactly the way the backend globs were,
one directory over. (Fixed 2026-11-24: the glob now covers `.ts`/`.tsx`, and CI
gates frontend errors; see below.) And `npm run lint` is `lint:cli && lint:backend &&
lint:frontend`, so while the backend leg is red the frontend leg **never
executes**; that error count came from running eslint directly, not from the
script. The clean-checkout blocker once reported here is gone: `npm ci
--dry-run` succeeds in `frontend/` (measured 2026-09-23), and the `@dicebear/*`
packages it named were removed with Commonly's own avatar kit.

Backend `.ts` reaches zero because 48 rules that fire on existing code are
parked in `backend/.eslintrc.js` with their counts — 2,127 errors, 72%
auto-fixable. Everything else in `airbnb-base` stays ON, so the gate catches
the first NEW violation of any of several hundred rules. Re-enabling the parked
48 is the burn-down task. The backend `.js` tests are parked the same way
since 2026-11-24 (see below).

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

## Backend `.js` errors gated (2026-11-24)

Measured on main `8f39b8885` before the change: 1,126 `.js` files, **9,273
errors**, 638 of the 641 dirty files under `__tests__`. That count was low:
the base config parsed `.js` as ES2020, so 66 tests using numeric separators
(`60_000`, an ES2021 feature) failed to parse and were never linted. With
`ecmaVersion: 2022` the count is 10,445.

Fixed rather than parked:

- **Parse errors (66):** `ecmaVersion` 2020 → 2022.
- **A duplicate key:** `oauthController.test.js` set `protocol` twice in one
  request fake.
- **An undeclared dependency:** 14 helm and deployment tests `require('js-yaml')`,
  which backend never declared. They got whatever was hoisted, 3.14.1 from
  istanbul. Backend now pins `js-yaml` 4.3.2 as a dev dependency, the same
  version the root uses. They call only `load`, `loadAll` and `split`, which
  4.x keeps.
- **An ambiguous line break:** `syntheticPurgeDm.test.js` opened the
  `it.each(...)` call's argument list on the next line.
- **The three non-test files** (`.eslintrc.js` and two scripts), with `--fix`
  plus one documented `global-require` disable in `usage-report.js`, which loads
  `mongodb` only when run.

Parked in the test override of `backend/.eslintrc.js`, with counts:

- **8 rules as test idioms, off for good** (1,266 errors): `global-require`
  (mocks first, `jest.isolateModules`), `no-restricted-syntax` and
  `no-await-in-loop` (ordered fixture steps), `no-promise-executor-return`
  (`setTimeout` waits), `no-template-curly-in-string` and `no-script-url`
  (inputs the code must refuse), and two class rules for test fakes.
- **41 rules as the burn-down** (9,081 errors in 533 files, 98.6%
  auto-fixable). `object-property-newline` and `object-curly-newline` alone are
  7,605 of them.

Now gated:

- The `Backend typecheck and lint` job runs `npm run lint -- --quiet`, so any
  new backend `.js` error fails CI. Warnings (about 2,800) are not gated.
- The `lint-staged` backend glob is `backend/**/*.{js,ts}`. lint-staged runs
  from the repo root, where ESLint 8 never reads `backend/.eslintignore`, so
  that list moved into `ignorePatterns` in `backend/.eslintrc.js`. Otherwise a
  commit would `--fix` the vendored `vendor/seats` copies, which must stay
  byte-identical to `packages/seats`.
- Root `npm run lint` exits 0, so its frontend leg runs again.

Re-enabling a parked rule: delete its line, run `npx eslint . --ext .js --fix`
in `backend/`, and land that rule's diff on its own, because a full-corpus
`--fix` touches 500+ test files and collides with every open backend PR.
