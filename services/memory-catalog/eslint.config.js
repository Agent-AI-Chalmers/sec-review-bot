import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import stylistic from '@stylistic/eslint-plugin'
import eslintConfigPrettier from 'eslint-config-prettier/flat'

// Match declarations directly and through export wrappers.
const declaration = (type) => ({
  selector: `${type}, ExportNamedDeclaration[declaration.type="${type}"], ExportDefaultDeclaration[declaration.type="${type}"]`,
})
const declarations = [
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
  'TSTypeAliasDeclaration',
].map(declaration)

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true } },
  },
  eslintConfigPrettier,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.ts', '**/*.tsx'],
    plugins: { '@stylistic': stylistic },
    rules: {
      // Prettier preserves blank lines but does not insert declaration separators.
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: declarations },
        { blankLine: 'always', prev: declarations, next: '*' },
        {
          blankLine: 'any',
          prev: declaration('TSTypeAliasDeclaration'),
          next: declaration('TSTypeAliasDeclaration'),
        },
        {
          blankLine: 'any',
          prev: declaration('TSDeclareFunction'),
          next: [
            declaration('TSDeclareFunction'),
            declaration('FunctionDeclaration'),
          ],
        },
      ],
    },
  },
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
            'Imports must come first in a module: move this import above the code.',
        },
      ],
    },
  },
)
