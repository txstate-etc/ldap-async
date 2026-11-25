import love from 'eslint-config-love'
import stylistic from '@stylistic/eslint-plugin'

const tsFiles = ['**/*.ts']

export default [
  // FORMATTING RULES
  {
    ...stylistic.configs.recommended,
    files: tsFiles
  },
  {
    files: tsFiles,
    rules: {
      '@stylistic/arrow-parens': ['error', 'as-needed'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/comma-dangle': ['error', 'never'],
      '@stylistic/indent': ['error', 2, { ignoreComments: true }],
      '@stylistic/max-statements-per-line': ['error', { max: 3 }],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/quote-props': ['error', 'as-needed'],
      '@stylistic/space-before-function-paren': ['error', 'always'],
      '@stylistic/type-annotation-spacing': 'error',
      '@stylistic/type-generic-spacing': 'error'
    }
  },
  // STRUCTURAL RULES
  {
    ...love,
    files: tsFiles
  },
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: './tsconfig.eslint.json'
      }
    },
    rules: {
      '@typescript-eslint/array-type': ['error', { default: 'array' }],
      '@typescript-eslint/class-methods-use-this': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/init-declarations': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-empty-function': 'off', // stream._read = () => {} is intentional
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off', // public API generics exist for callers, not for us
      // this library wraps untyped mysql2 internals (e.g. _connection) and error objects, so `any` is everywhere on purpose
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/prefer-destructuring': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': ['error', { ignoreConditionalTests: true, ignorePrimitives: { bigint: false, boolean: false, number: false, string: true } }],
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingAny: true, allowThrowingUnknown: true }],
      '@typescript-eslint/prefer-readonly': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowAny: true }],
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/strict-void-return': 'off',
      '@typescript-eslint/unbound-method': 'off', // Error.captureStackTrace(e, this.query) is the intended usage
      '@eslint-community/eslint-comments/require-description': 'off',
      complexity: 'off',
      'max-lines': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'max-depth': 'off',
      'no-await-in-loop': 'off',
      'no-console': 'off',
      'no-loop-func': 'off',
      'no-negated-condition': 'off',
      'no-param-reassign': 'off', // mutating options/binds/err params is a core pattern here
      'no-plusplus': 'off',
      'no-promise-executor-return': 'off',
      'prefer-named-capture-group': 'off',
      'prefer-template': 'off',
      'promise/avoid-new': 'off',
      'require-atomic-updates': 'off',
      'require-unicode-regexp': 'off'
    }
  },
  // RELAXED RULES FOR TEST FILES
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  }
]
