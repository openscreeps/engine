import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.reference/**'] },
  {
    files: ['**/*.ts', '**/*.cts'],
    extends: [eslint.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['conformance/**/*.cts'],
    rules: {
      // Native Node TypeScript must retain explicit CJS loading for the pinned oracle.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
