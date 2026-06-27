import tseslint from 'typescript-eslint';
import solid from 'eslint-plugin-solid';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    // Generated declaration files + the build output are exempt from all rules.
    ignores: ['**/*.d.ts', 'static/dist/**'],
  },
  {
    plugins: { solid },
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // 200-line cap (raw lines — a long file floods context regardless of comments).
      // The matching unit spec (file-size.spec.ts) lists offenders to split.
      'max-lines': ['error', { max: 200, skipBlankLines: false, skipComments: false }],
      // Ban bare string literals in JSX class attributes — use CSS module references instead.
      // A string class like class="btn-primary" bypasses the module system and leaks into
      // the legacy stylesheet; dynamic template literals and module expressions are fine.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXAttribute[name.name="class"] > Literal',
          message: 'Use CSS module class reference (e.g. class={styles.foo}) instead of a bare string literal.',
        },
        {
          // Catch bare letter-containing text in JSX text nodes — use t('key') instead.
          // Allows: whitespace-only nodes, punctuation/symbols (←→✕✓☀☾·…≥%), numbers.
          // Allowlist patterns that are intentionally untranslated: data values ({p.kind}
          // etc.), format-string fragments, and tool identifiers are in expressions, not
          // JSXText nodes, so they aren't caught here.
          selector: 'JSXText[value=/[a-zA-Z]/]',
          message: 'Hardcoded user-visible text — wrap in t("key") and add the key to en.json.',
        },
      ],
      // These are noisy for this codebase — suppress while types are still maturing
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
