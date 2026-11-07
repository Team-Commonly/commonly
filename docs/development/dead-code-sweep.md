# Dead-code sweeps with knip

What a sweep needs to know before trusting `knip --include exports,types`. knip 5 run on `backend/` with `server.ts`, scripts, migrations, seeds and tests as entry points flagged 323 exports and 431 types on 2026-11-07, and most of the exports were not dead.

## How to run it

Run knip in a capped container on a throwaway copy (`git archive HEAD backend frontend`), so `node_modules` and the `knip.json` stay out of the worktree. Neither package carries a knip config.

## False positives

- **`const svc = require('./x'); svc.name()`.** knip does not follow member access on a required module object, and most backend callers are written this way. Of 140 flagged backend exports whose name appears elsewhere in the repo, about 90 appear as `something.name`, and 39 are referenced only from tests. Exports of `connectorDeliveryFailureService` are flagged while seven backend modules require it.
- **The CommonJS interop trailer.** Over 130 backend `.ts` files end in `module.exports = exports.default; Object.assign(module.exports, exports);`. There, `require()` returns the default export with the named ones attached, so a flagged `default` is what every `require()` caller receives, and a flagged named export is still a property of that object.
- **Text consumers.** `backend/__tests__` and `frontend/src/v2/__tests__/v2-layout-invariants.test.ts` read source files as strings. A scanner that reads a file does not show up as an import.

## Proving a candidate

1. Word-match the name across every tracked file except `_external/`, not only `backend/` and `frontend/`. Any hit outside the declaring file moves the candidate to the inventory, even an unrelated one. This over-rejects on purpose.
2. Count uses inside the declaring file. A symbol that is used there loses only its `export` keyword. A symbol that appears only in its own declaration has no callers and can be deleted, after checking what the deletion strands.
3. Types: a dropped `export` on a type has no runtime effect and `tsc` catches every importer, since the backend emits no declarations.
4. Frontend `export default`: list every importer of the module, including `jest.mock` and `import()`. If all of them take the named export, the default goes. `tsc` rejects a missed default import in `.ts` and `.tsx`, but not in a `jest.mock` factory.
