import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'dist-server/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**'
    ]
  },
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
  },
  {
    // Playwright `page.evaluate` callbacks execute in the browser, so these scripts
    // need browser globals on top of the Node ones declared above.
    files: ['test/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        getComputedStyle: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        // Browser flows parse page URLs to identify the run they opened.
        URL: 'readonly'
      }
    }
  },
  eslintConfigPrettier,
  {
    // A misplaced import still works because ES modules hoist it, so nothing else
    // notices it. This rule is the only thing that keeps imports where readers look.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program > :not(ImportDeclaration) ~ ImportDeclaration',
          message:
            'Imports must come first in a module: move this import above the code.'
        }
      ]
    }
  }
)
