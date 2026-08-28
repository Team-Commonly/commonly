module.exports = {
  env: {
    node: true,
    es6: true,
    jest: true,
  },
  extends: ['airbnb-base'],
  parserOptions: {
    ecmaVersion: 2020,
  },
  rules: {
    // Allow console logs
    'no-console': 'off',

    // Less strict about return statements in async functions
    'consistent-return': 'off',

    // Allow unused variables in certain contexts
    'no-unused-vars': [
      'warn',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      },
    ],
    'max-len': ['warn', { code: 120 }],
    'no-underscore-dangle': 'off', // Allow _id from MongoDB
    'no-param-reassign': ['error', { props: false }],
    'func-names': 'off',
    'linebreak-style': 'off', // Don't enforce Windows/Unix line endings

    // Fix for ESLint version compatibility issue
    'prefer-regex-literals': 'off',
  },
  overrides: [
    {
      // TypeScript. Added 2026-08-28 for TASK-024, which measured backend
      // eslint reaching 0 of 286 `.ts` files: `npm run lint` was scoped
      // `--ext .js`, every backend `lint-staged` glob had gone stale to zero
      // as its files were converted, and no CI job ran backend lint at all.
      //
      // Sam ruled STAGED: enforce on NEW and CHANGED files now, burn the
      // existing 286 down separately. So this override has to be clean on a
      // typical changed file TODAY, or the gate blocks every backend PR on
      // pre-existing debt the author did not create. Each disable below is
      // there because it fired on real files in this repo, not on principle.
      files: ['**/*.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      plugins: ['@typescript-eslint'],
      rules: {
        // TypeScript's own checker owns undefined symbols and unused locals,
        // and it runs in CI already (`tsc --noEmit`). The base rules do not
        // understand type-only syntax and report false positives on it.
        'no-undef': 'off',
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'warn',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        // Resolution is tsconfig's job here; the import plugin has no TS
        // resolver configured and reports every relative import unresolved.
        'import/extensions': 'off',
        'import/no-unresolved': 'off',
        // This codebase deliberately uses inline `require()` inside functions
        // to break import cycles between services, and says so in comments at
        // the call sites.
        'global-require': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        // Mongoose/Express handlers legitimately await inside loops over
        // documents, and the `for...of` they use is what `no-restricted-syntax`
        // bans. Both are pervasive and neither is a defect here.
        'no-await-in-loop': 'off',
        'no-restricted-syntax': 'off',

        // ── THE BURN-DOWN LIST ────────────────────────────────────────────
        // Every rule below fires on code that is already on main. They are
        // parked so the changed-file gate is green TODAY; re-enabling them is
        // the follow-up task, and the counts are what sizes it.
        //
        // Measured 2026-08-28 at main ccacf0235 across 310 backend `.ts`
        // files: 48 rules, 2,127 errors, 232 dirty files, 72% auto-fixable
        // with `--fix`. Counts are errors, not files.
        //
        // Parking is deliberately mechanical — "it fires on existing code" —
        // rather than a judgement call per rule, so that nobody has to trust
        // my taste to reproduce the list. Re-run the measurement and you get
        // exactly these 48.
        //
        // NOT all of these are style. Four are correctness-relevant and total
        // six errors between them: no-cond-assign (3), no-redeclare (1),
        // prefer-const (1), no-param-reassign (1). They are the cheapest and
        // most valuable first slice of the burn-down.
        //
        // Everything NOT listed here stays ON. That is the point: several
        // hundred airbnb-base rules currently fire zero times on this corpus,
        // so the gate is not vacuous — it catches the first NEW violation of
        // any of them.
        'object-curly-newline': 'off', // 600
        quotes: 'off', // 407
        'import/no-import-module-exports': 'off', // 192
        'no-continue': 'off', // 124
        'operator-linebreak': 'off', // 106
        'dot-notation': 'off', // 100
        indent: 'off', // 88
        'function-paren-newline': 'off', // 66
        'no-useless-escape': 'off', // 45
        'no-use-before-define': 'off', // 40
        'no-multi-spaces': 'off', // 34
        'prefer-destructuring': 'off', // 27
        'no-template-curly-in-string': 'off', // 26
        'no-shadow': 'off', // 23
        'implicit-arrow-linebreak': 'off', // 21
        'import/prefer-default-export': 'off', // 20
        'object-property-newline': 'off', // 20
        'no-nested-ternary': 'off', // 19
        'class-methods-use-this': 'off', // 18
        'import/order': 'off', // 18
        'no-void': 'off', // 16
        'no-plusplus': 'off', // 14
        'prefer-template': 'off', // 14
        camelcase: 'off', // 12
        'import/newline-after-import': 'off', // 11
        'function-call-argument-newline': 'off', // 10
        'no-promise-executor-return': 'off', // 8
        'lines-between-class-members': 'off', // 7
        'newline-per-chained-call': 'off', // 6
        'import/first': 'off', // 5
        'no-multiple-empty-lines': 'off', // 4
        'default-param-last': 'off', // 3
        'import/no-extraneous-dependencies': 'off', // 3
        'no-cond-assign': 'off', // 3
        'brace-style': 'off', // 2
        'import/no-duplicates': 'off', // 2
        'no-unneeded-ternary': 'off', // 2
        curly: 'off', // 1
        'max-classes-per-file': 'off', // 1
        'no-confusing-arrow': 'off', // 1
        'no-misleading-character-class': 'off', // 1
        'no-param-reassign': 'off', // 1
        'no-redeclare': 'off', // 1
        'nonblock-statement-body-position': 'off', // 1
        'object-shorthand': 'off', // 1
        'padded-blocks': 'off', // 1
        'prefer-const': 'off', // 1
        'vars-on-top': 'off', // 1
      },
    },
    {
      // For test files
      files: ['**/__tests__/**/*.js', '**/*.test.js'],
      rules: {
        'no-unused-vars': 'off',
        'no-undef': 'off',
        'no-const-assign': 'off', // For test mocks
        'no-trailing-spaces': 'off', // Disable trailing spaces in test files
      },
    },
    {
      // For migration and utility scripts
      files: [
        '**/migrations/**/*.js',
        '**/utils/**/*.js',
        'sync-pods.js',
        'testPG.js',
      ],
      rules: {
        'no-restricted-syntax': 'off',
        'no-await-in-loop': 'off',
        'no-continue': 'off',
        'no-plusplus': 'off',
        'global-require': 'off',
      },
    },
    {
      // For server.js and controllers
      files: ['server.js', '**/controllers/**/*.js'],
      rules: {
        'global-require': 'off',
        'one-var': 'off',
        'one-var-declaration-per-line': 'off',
        'object-curly-newline': 'off',
        'comma-dangle': ['error', 'always-multiline'],
        'no-trailing-spaces': 'error',
      },
    },
  ],
};
