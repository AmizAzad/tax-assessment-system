/**
 * Repository lint configuration.
 *
 * Two rule groups here are architectural controls, not style preferences, and
 * are referenced directly by the plan:
 *
 *   1. Money arithmetic (ADR-007, plan section 2.2). TypeScript already rejects
 *      `Money + Money`, but it cannot stop someone unwrapping to a number
 *      first. These rules make the unwrap visible in review.
 *
 *   2. Module boundaries (plan section 14.2). `tax-assessment` may import from
 *      `workflow`, `forms` and `platform`. Nothing may import from
 *      `tax-assessment`. This is what keeps the platform reusable and the
 *      domain replaceable; without enforcement it erodes in weeks.
 *
 * Both were verified by deliberately violating them and watching the rule
 * fire. A control nobody has watched fail is not a control.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2023: true },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'coverage/',
    '**/*.js',
    'apps/web/',
    'apps/bpmn-engine/',
  ],
  settings: {
    'import/resolver': {
      node: { extensions: ['.ts', '.js'] },
    },
  },
  rules: {
    // ------------------------------------------------------------------ money
    // Name-based, deliberately: this is a review prompt, not a type system.
    // The type system already rejects `Money + Money`; these catch the
    // unwrap-to-number path that it cannot see.
    'no-restricted-syntax': [
      'error',
      {
        selector:
          'BinaryExpression[operator=/^[+\\-*/%]$/] > Identifier[name=/([Aa]mount|[Tt]otal|[Bb]alance|[Pp]ayable|[Tt]ax|[Pp]enalty|[Ii]nterest|[Cc]redit)$/]',
        message:
          'Monetary values must not use arithmetic operators. Use the Money type from @tas/decimal (ADR-007)',
      },
      {
        selector: "CallExpression[callee.object.name='Math'][callee.property.name='round']",
        message:
          'Math.round is floating point. Use Money.round() with an explicit statutory RoundingRule (ADR-007)',
      },
      {
        selector: "NewExpression[callee.name='Number']",
        message:
          'Do not coerce monetary strings to Number. Construct Money from the string (ADR-007)',
      },
    ],

    // ------------------------------------------------------------- boundaries
    // A zone says: files under `target` may not import from `from`.
    // Read the list as the inverse of the allowed direction:
    //   tax-assessment -> workflow, forms, platform
    //   workflow       -> platform
    //   forms          -> platform
    //   platform       -> (nothing above it)
    'import/no-restricted-paths': [
      'error',
      {
        zones: [
          {
            target: './apps/api/src/platform',
            from: './apps/api/src/tax-assessment',
            message:
              'platform must not import from tax-assessment. The platform is domain-agnostic (plan 14.2)',
          },
          {
            target: './apps/api/src/platform',
            from: './apps/api/src/workflow',
            message: 'platform must not import from workflow (plan 14.2)',
          },
          {
            target: './apps/api/src/platform',
            from: './apps/api/src/forms',
            message: 'platform must not import from forms (plan 14.2)',
          },
          {
            target: './apps/api/src/forms',
            from: './apps/api/src/tax-assessment',
            message: 'forms must not import from tax-assessment (plan 14.2)',
          },
          {
            target: './apps/api/src/forms',
            from: './apps/api/src/workflow',
            message: 'forms must not import from workflow (plan 14.2)',
          },
          {
            target: './apps/api/src/workflow',
            from: './apps/api/src/tax-assessment',
            message: 'workflow must not import from tax-assessment (plan 14.2)',
          },
          {
            target: './packages',
            from: './apps',
            message: 'Shared packages must not depend on applications (plan 14.2)',
          },
        ],
      },
    ],

    // ---------------------------------------------------------------- general
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always'],
    'import/no-cycle': 'error',
  },
  overrides: [
    {
      // Tests exercise the guards, so they need the escape hatches the rules
      // otherwise forbid.
      files: ['**/test/**/*.ts', '**/*.spec.ts'],
      rules: {
        'no-restricted-syntax': 'off',
        '@typescript-eslint/no-explicit-any': 'off',
        'import/no-restricted-paths': 'off',
      },
    },
    {
      // The money package is the one place that legitimately touches raw
      // numbers and Decimal internals.
      files: ['packages/decimal/src/**/*.ts'],
      rules: { 'no-restricted-syntax': 'off' },
    },
  ],
};
