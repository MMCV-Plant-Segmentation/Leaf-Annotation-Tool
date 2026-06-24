import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    plugins: { solid },
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // Ban bare string literals in JSX class attributes — use CSS module references instead.
      // A string class like class="btn-primary" bypasses the module system and leaks into
      // the legacy stylesheet; dynamic template literals and module expressions are fine.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="class"] > Literal',
          message: 'Use CSS module class reference (e.g. class={styles.foo}) instead of a bare string literal.',
        },
      ],
      // These are noisy for this codebase — suppress while types are still maturing
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
