const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');

const TYPE_DECLARATIONS_ONLY_IN_TYPES_DIR = [
  {
    selector: 'TSInterfaceDeclaration',
    message: 'Interfaces must live in src/@types/.',
  },
  {
    selector: 'TSTypeAliasDeclaration',
    message: 'Type aliases must live in src/@types/.',
  },
  {
    selector: 'TSModuleDeclaration',
    message: 'Ambient module/namespace declarations must live in src/@types/.',
  },
];

const NO_ENUM = {
  selector: 'TSEnumDeclaration',
  message: 'Enums are forbidden. Use an `as const` object and derive the type in src/@types/.',
};

const forbidImportsFrom = (patterns) => ({
  'no-restricted-imports': [
    'error',
    { patterns: patterns.map(([group, message]) => ({ group: [group], message })) },
  ],
});

module.exports = tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-selftest/**',
      'tools/**',
      'out/**',
      'node_modules/**',
      'coverage/**',
      'scripts/**',
      'tests/**',
      'vite.*.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: __dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // Handlers registered with Electron/DOM APIs are allowed to be async or return promises.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // `result: void` is the natural way to say "no return value" in the IPC contract.
      '@typescript-eslint/no-invalid-void-type': 'off',
    },
  },

  // The type-declaration rule: types live in src/@types/, enums nowhere.
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...TYPE_DECLARATIONS_ONLY_IN_TYPES_DIR, NO_ENUM],
    },
  },
  {
    files: ['src/@types/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_ENUM] },
  },

  // Boundaries: only src/@types and src/shared are shared between the native side, the preload
  // script and the UI. Only the native side may use GTK/WebKit (gi://).
  {
    files: ['src/main/**/*.ts'],
    rules: {
      ...forbidImportsFrom([
        ['**/renderer/**', 'the native side must not import UI code.'],
        ['**/preload/**', 'the native side must not import preload code.'],
      ]),
      // The GTK/WebKit typings declare many nullable results (get_uri, get_title, ...) as
      // non-null, so guarding them is necessary even where the types say it is not.
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },
  {
    files: ['src/preload/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: forbidImportsFrom([
      ['**/main/**', 'preload must not import native code.'],
      ['**/renderer/**', 'preload must not import UI code.'],
      ['gi://*', 'preload runs in the page and cannot use GTK or WebKit.'],
    ]),
  },
  {
    files: ['src/renderer/**/*.ts'],
    languageOptions: { globals: globals.browser },
    rules: forbidImportsFrom([
      ['**/main/**', 'the UI must not import native code.'],
      ['**/preload/**', 'the UI must not import preload code.'],
      ['gi://*', 'the UI talks to the native side only through window.browserApi.'],
    ]),
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: forbidImportsFrom([['gi://*', 'shared code must not import GTK or WebKit.']]),
  },

  // Config files at the repository root.
  {
    files: ['*.js', '*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      // eslint.config.js is CommonJS because package.json is not "type": "module".
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  prettier,
);
