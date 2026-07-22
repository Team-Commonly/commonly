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
    'i18next',
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
  // Phase 1A zh-CN manifest. Later phases extend this exact list as each
  // surface migrates, so translated components cannot regress to JSX literals.
  overrides: [
    {
      files: [
        'src/v2/landing/V2LandingPage.tsx',
        'src/v2/components/V2LangSwitch.tsx',
      ],
      rules: {
        'i18next/no-literal-string': ['error', {
          mode: 'jsx-only',
          'jsx-attributes': {
            exclude: [
              'className', 'styleName', 'style', 'type', 'key', 'id',
              'width', 'height', 'to', 'href', 'src', 'rel', 'target',
              'variant', 'size', 'component', 'role', 'name', 'autoComplete',
              'inputMode', 'accept', 'd', 'viewBox', 'fill', 'fontSize', 'stroke',
              'sx', 'value', 'aria-hidden', 'anchorOrigin', 'transformOrigin',
              'PaperProps',
            ],
          },
        }],
      },
    },
  ],
};
