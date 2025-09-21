module.exports = {
  env: {
    browser: true,
    es6: true,
    jest: true,
  },
  extends: [
    'react-app',
    'plugin:react/recommended',
  ],
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 2020,
    sourceType: 'module',
  },
  plugins: [
    'react',
    'react-hooks',
  ],
  rules: {
    // More lenient rules for development to reduce CPU usage
    'react/jsx-filename-extension': ['warn', { extensions: ['.js', '.jsx'] }],
    'react/prop-types': 'off', // Disable prop-types validation to reduce warnings
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'off', // Disable exhaustive deps warnings
    'no-unused-vars': 'off', // Disable unused vars warnings in development
    'max-len': 'off', // Disable max line length warnings
    'linebreak-style': 'off', // Don't enforce Windows/Unix line endings
  },
  settings: {
    react: {
      version: 'detect',
    },
  },
}; 