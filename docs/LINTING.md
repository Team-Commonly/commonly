# Linting Policy and Auto-Fix Setup

## Overview

This project uses ESLint for code quality and style enforcement. We have separate ESLint configurations for the backend (Node.js) and frontend (React) parts of the application.

## Linting Rules

### Backend (Node.js)
- Based on Airbnb style guide with customizations
- Allows console logs
- Relaxed rules for async function return statements
- Warns (instead of errors) for unused variables with special pattern (`_` prefix)
- Maximum line length of 120 characters
- MongoDB-specific exceptions (like allowing `_id`)
- Special rule relaxations for tests, migrations, and utilities

### Frontend (React)
- Based on react-app and react/recommended configs
- Allows JSX in .js files
- Enforces React Hooks rules
- Warns about prop-types (instead of errors)
- Maximum line length of 120 characters
- Warns (instead of errors) for unused variables

## Auto-Fixing Lint Issues

### Available Commands

We've set up several npm scripts to help with linting:

- **Run linting checks:**
  ```
  npm run lint         # Both frontend and backend
  npm run lint:backend # Backend only
  npm run lint:frontend # Frontend only
  ```

- **Auto-fix linting issues:**
  ```
  npm run lint:fix          # Both frontend and backend
  npm run lint:fix:backend  # Backend only
  npm run lint:fix:frontend # Frontend only
  ```

### Pre-commit Hook

A pre-commit hook is configured to automatically run lint-staged before each commit. This will:
1. Check for linting issues in files that are being committed
2. Automatically fix issues that can be auto-fixed
3. Prevent the commit if there are issues that cannot be auto-fixed

### Development Workflow

1. Write your code without worrying too much about linting rules
2. Before committing, run `npm run lint:fix` to automatically fix most issues
3. Fix any remaining issues manually
4. Commit your changes - the pre-commit hook will verify everything is properly linted

## IDE Integration

For a better development experience, configure your IDE to use ESLint:

### VS Code
1. Install the ESLint extension
2. Add the following to your workspace settings:
```json
{
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  },
  "eslint.validate": [
    "javascript",
    "javascriptreact"
  ]
}
```

### Cursor
Cursor has built-in ESLint support. You can enable auto-fix on save in the settings.

## Adding New Rules

When adding new ESLint rules, consider:
1. Is the rule automatable (can ESLint auto-fix it)?
2. Is it worth enforcing strictly (error) or as a suggestion (warning)?
3. Does it need exceptions for certain file types or directories?

Update the appropriate `.eslintrc.js` file to add new rules. 