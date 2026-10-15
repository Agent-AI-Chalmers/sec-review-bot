import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.agent-input-bundles/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 'latest'
      },
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        Request: 'readonly',
        RequestInit: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
        structuredClone: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly'
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      ...tseslint.plugin.configs.recommended.rules,
      '@typescript-eslint/ban-ts-comment': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' }
      ],
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'never'],
      'comma-dangle': ['error', 'never'],
      'eol-last': ['error', 'always']
    }
  }
]
