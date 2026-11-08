# Dead-code sweeps with knip

What a sweep needs to know before trusting `knip --include exports,types`. knip 5 run on `backend/` with `server.ts`, scripts, migrations, seeds and tests as entry points flagged 323 exports and 431 types on 2026-11-07, and most of the exports were not dead.

## How to run it

Run knip in a capped container on a throwaway copy, so `node_modules` and the `knip.json` stay out of the worktree. Neither package carries a knip config. `git archive` writes a tar to stdout, so extract it into the copy:

```bash
mkdir -p <dir> && git archive HEAD backend frontend package.json | tar -x -C <dir>
```

## False positives

- **`const svc = require('./x'); svc.name()`.** knip does not follow member access on a required module object, and most backend callers are written this way. Of 140 flagged backend exports whose name appears elsewhere in the repo, about 90 appear as `something.name`, and 39 are referenced only from tests. Exports of `connectorDeliveryFailureService` are flagged while seven backend modules require it.
- **The CommonJS interop trailer.** 135 backend `.ts` files end in `Object.assign(module.exports, exports)`, after `module.exports = exports["default"]` in 106 of them and `module.exports = exports.default` in 19. There, `require()` returns the default export with the named ones attached, so a flagged `default` is what every `require()` caller receives, and a flagged named export is still a property of that object.
- **Text consumers.** `backend/__tests__` and `frontend/src/v2/__tests__/v2-layout-invariants.test.ts` read source files as strings. A scanner that reads a file does not show up as an import.

## Proving a candidate

1. Word-match the name across every tracked file except `_external/`, not only `backend/` and `frontend/`. Any hit outside the declaring file moves the candidate to the inventory, even an unrelated one. This over-rejects on purpose.
2. Count uses inside the declaring file. A symbol that is used there loses only its `export` keyword. A symbol that appears only in its own declaration has no callers and can be deleted, after checking what the deletion strands. A word match misses a default export, because `const x = require('./mod')` can bind it under any name. When the symbol is the module's default, list the importers by module path and read how each one uses the binding.
3. Types: a dropped `export` on a type has no runtime effect. `tsc` catches a remaining importer in non-test code only, since tests are not type-checked: backend `tsconfig.json` lists 21 `.ts` and 997 `.js` test files, but `checkJs` is off and the 21 `.ts` tests carry `@ts-nocheck`, and `tsconfig.typescheck.json` and `tsconfig.build.json` exclude tests. The frontend has 134 files with `@ts-nocheck`. For tests, the word match in step 1 is the proof.
4. Frontend `export default`: list every importer of the module, including `jest.mock` and `import()`. If all of them take the named export, the default goes. `tsc` rejects a missed default import in `.ts` and `.tsx`, but not in a `jest.mock` factory.
