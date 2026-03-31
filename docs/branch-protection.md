# Branch protection for `main`

Apply these GitHub repository settings:

- Require a pull request before merging
- Require approvals before merging
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Required checks:
  - `Code Quality`
  - `Test & Coverage`
  - `Playwright Tests / test`
- Restrict pushes to admins and maintainers as appropriate

Add or confirm these labels for automation:

- `ci`
- `infra`
- `build`
- `code`

Current workflow gaps to track separately:

1. Add workflow concurrency and cancel-in-progress to prevent duplicate CI runs on new pushes.
2. Add release workflow gates and signed/tagged release automation for safer deployments.
3. Standardize coverage reporting and artifact retention for faster debugging.
