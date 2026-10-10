// ESLint 9 flat config.
//
// Uses only packages that are already installed:
//   - @eslint/js (a direct dependency of eslint itself)
//   - @typescript-eslint/parser + @typescript-eslint/eslint-plugin
// (the `typescript-eslint` meta package is not installed.)
//
// Type-aware rules are not enabled (no parserOptions.project) to keep lint fast
// and independent of tsconfig include/exclude lists.

const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'public/**', 'haraka/**'],
  },

  js.configs.recommended,

  // typescript-eslint recommended (base + eslint-recommended overrides + recommended rules)
  ...tsPlugin.configs['flat/recommended'],

  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // `any` is sometimes pragmatic (Express/Prisma glue); flag, don't fail.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // CommonJS interop (require) is used in a few places (e.g. nanoid v3).
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `declare global { namespace NodeJS / Express { ... } }` augmentation is fine.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],
      // Control-char ranges are used deliberately in input validators
      // (e.g. rejecting \x00-\x1f to prevent SMTP header injection).
      'no-control-regex': 'off',
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // Tests: relax rules that are noisy for mocks/fixtures.
  {
    files: ['src/__tests__/**/*.ts', 'src/__mocks__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Plain JS config files (this file, jest config, etc.) are CommonJS on Node.
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];
