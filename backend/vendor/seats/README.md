# Vendored: the record-v1 reference writer

These files are copied byte for byte from `packages/seats/src` so the backend
writes the same `seats.record` format as a local seat (ADR-033 D1, TASK-513).
The backend image is built from `backend/` alone and cannot reach
`packages/seats` at runtime.

Do not edit them here. Change `packages/seats`, then run
`npm run sync:seats-record` in `backend/`.
`__tests__/unit/vendor/seatsRecordVendor.test.js` fails when a copy differs
from its source, or when a copied file imports one that was not copied.

They are ESM. `tsc` and `ts-jest` (see `jest.config.js`) compile them to
CommonJS with the rest of the backend.
