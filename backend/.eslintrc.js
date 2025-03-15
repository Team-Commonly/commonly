module.exports = {
  env: {
    node: true,
    jest: true,
    es6: true,
  },
  extends: [
    'airbnb-base',
  ],
  parserOptions: {
    ecmaVersion: 2020,
  },
  rules: {
    // Customize rules to be less strict for easier adoption
    'no-console': 'off',
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'max-len': ['warn', { code: 120 }],
    'no-underscore-dangle': 'off', // Allow _id from MongoDB
    'no-param-reassign': ['error', { props: false }],
    'consistent-return': 'warn',
    'func-names': 'off',
    'linebreak-style': 'off', // Don't enforce Windows/Unix line endings
  },
  overrides: [
    {
      files: ['**/*.test.js', '**/__tests__/**/*.js'],
      env: {
        jest: true,
      },
      rules: {
        'global-require': 'off',
        'import/no-extraneous-dependencies': 'off',
      },
    },
  ],
}; 