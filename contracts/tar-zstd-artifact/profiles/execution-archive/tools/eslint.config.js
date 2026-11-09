import { defineConfig } from 'eslint/config'
import js from '@eslint/js'
import stylistic from '@stylistic/eslint-plugin'
import eslintConfigPrettier from 'eslint-config-prettier/flat'
import globals from 'globals'

// Match declarations directly and through export wrappers.
const declaration = (type) => ({
  selector: `${type}, ExportNamedDeclaration[declaration.type="${type}"], ExportDefaultDeclaration[declaration.type="${type}"]`
})
const declarations = [
  'FunctionDeclaration',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSEnumDeclaration',
  'TSTypeAliasDeclaration'
].map(declaration)

export default defineConfig(
  { ignores: ['node_modules/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node }
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
          next: declaration('TSTypeAliasDeclaration')
        },
        {
          blankLine: 'any',
          prev: declaration('TSDeclareFunction'),
          next: [
            declaration('TSDeclareFunction'),
            declaration('FunctionDeclaration')
          ]
        }
      ]
    }
  }
)
