const js = require('@eslint/js');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const prettierConfig = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'node_modules/**',
      'graphify-out/**',
      'strix_runs/**',
      'src/renderer/public/noVNC/**',
      // Worktrees de outras sessões (cópias de outros branches) não são deste checkout.
      '.claude/**',
    ],
  },
  js.configs.recommended,
  {
    // catch {} with no binding is the project's convention for deliberately
    // ignored best-effort errors (fs probing, teardown cleanup, etc).
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    files: ['src/main/**/*.js', 'scripts/**/*.js', '*.config.js'],
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/renderer/vite.config.js'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },
  {
    // Vitest requires ESM import syntax even for files that test a CJS
    // (require/module.exports) source module.
    files: ['**/__tests__/**/*.js', '**/*.test.{js,jsx}'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/renderer/src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    settings: { react: { version: '18.3' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // Newer react-hooks v7 rules aimed at React Compiler compatibility.
      // Real fixes require restructuring the VNC reconnect effects
      // (RemoteViewer) and drag/drop ref usage (FileExplorer) with an
      // actual VNC session to verify against -- tracked as follow-up
      // rather than blocking lint on an unverified behavioral change.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  prettierConfig,
];
