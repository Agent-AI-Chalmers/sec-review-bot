import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'dist-server/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      globals: {
        console: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        window: 'readonly',
        Buffer: 'readonly',
        process: 'readonly',
        URL: 'readonly'
      }
    },
    rules: { '@typescript-eslint/explicit-function-return-type': 'error' }
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } }
  }
)
