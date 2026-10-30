import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.wrangler/**',
      '**/*.config.*',
      '**/vite.config.*',
      '**/drizzle.config.*',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      boundaries,
    },
    settings: {
      'boundaries/elements': [
        { type: 'shared', pattern: 'packages/shared/src/**/*' },
        { type: 'database', pattern: 'packages/database/src/**/*' },
        { type: 'api', pattern: 'packages/api/src/**/*' },
        { type: 'web', pattern: 'packages/web/src/**/*' },
        { type: 'test-utils', pattern: 'packages/test-utils/src/**/*' },
      ],
      'boundaries/ignore': [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.config.*',
        '**/vite.config.*',
        '**/drizzle.config.*',
      ],
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            { from: 'shared', allow: ['shared'] },
            { from: 'database', allow: ['shared', 'database'] },
            { from: 'api', allow: ['shared', 'database', 'api', 'test-utils'] },
            { from: 'web', allow: ['shared', 'web', 'test-utils'] },
            { from: 'test-utils', allow: ['shared', 'test-utils'] },
          ],
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
