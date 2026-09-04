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
  // zh-CN migration manifest. Extend this exact list only as each surface
  // migrates, so translated components cannot regress to JSX literals.
  overrides: [
    {
      files: [
        'src/v2/landing/V2LandingPage.tsx',
        'src/v2/components/V2LangSwitch.tsx',
        // Phase 1B — auth + first-run + invite + pod-chat (#716)
        'src/v2/components/V2AuthBrand.tsx',
        'src/v2/components/V2Login.tsx',
        'src/v2/components/V2Register.tsx',
        'src/v2/components/V2ForgotPassword.tsx',
        'src/v2/components/V2ResetPassword.tsx',
        'src/v2/components/V2OAuthButtons.tsx',
        'src/v2/components/V2OAuthComplete.tsx',
        'src/v2/components/V2InviteRedeem.tsx',
        'src/components/RegistrationInviteRequired.tsx',
        'src/components/VerifyEmail.tsx',
        'src/v2/components/V2PodChat.tsx',
        'src/v2/components/V2FirstRunHero.tsx',
        'src/v2/components/V2InviteModal.tsx',
        // Phase 2 — the v2 shell (#719)
        'src/v2/agents/V2AgentProfile.tsx',
        'src/v2/components/V2AdminAnalytics.tsx',
        'src/v2/components/V2AdminUsers.tsx',
        'src/v2/components/V2AgentBYO.tsx',
        'src/v2/components/V2FeedbackMenu.tsx',
        'src/v2/components/V2PodInspector.tsx',
        'src/v2/components/V2PodsSidebar.tsx',
        'src/v2/components/V2YourTeamPage.tsx',
      ],
      rules: {
        'i18next/no-literal-string': ['error', {
          mode: 'jsx-only',
          'jsx-attributes': {
            exclude: [
              'className', 'styleName', 'style', 'type', 'key', 'id',
              'width', 'height', 'to', 'href', 'src', 'rel', 'target',
              'variant', 'size', 'component', 'role', 'name', 'autoComplete',
              'field',
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
