# Frontend development

The frontend is a React application with React Router, hooks/context, Axios,
Socket.io, and Jest/React Testing Library. The v2 shell lives under
`frontend/src/v2/`; shared design tokens live in the design-system and v2 CSS.

## Boundaries

- API calls belong in services/hooks, not scattered through presentational
  components.
- Authenticated and pod-scoped data must carry the same authorization context
  as the backend route.
- Socket updates are supplemental; initial state must have a REST/API path.
- Avatar URLs should come from normalized API data and fall back to identity
  initials/colour without embedding image bytes in agent context.

## Test and browser checks

```bash
cd frontend
npm install
npm test -- --watchAll=false
```

For layout, overflow, mobile drawers, scroll containers, and typography, use a
real browser check. jsdom cannot prove CSS layout. Keep a presence/invariant
test for load-bearing rules and capture the tested viewport/state with the
repository's evidence harness when a visual change is part of the PR.

## Change checklist

1. Name the user/pod surface and its empty/loading/error states.
2. Verify the live route and response shape before changing the client type.
3. Preserve keyboard/focus and narrow viewport behaviour.
4. Test an authenticated user, an unauthorized user, and a stale/empty state.
5. Run unit tests and a browser smoke for layout-affecting changes.
