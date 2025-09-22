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
