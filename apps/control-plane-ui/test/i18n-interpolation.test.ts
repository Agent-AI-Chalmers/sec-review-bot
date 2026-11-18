import { expect, test } from 'vitest'

import { messages, translate } from '../browser/shared/i18n.js'

test('file names are literal values, including replacement syntax and placeholders', () => {
  for (const language of ['en', 'zh'] as const) {
    for (const file of ["cost-$&-$$-$`-$'.md", '{file}-{count}.md']) {
      expect(translate(language, 'deleteFileWarning', { file })).toBe(
        messages[language].deleteFileWarning.split('{file}').join(file)
      )
    }
    expect(translate(language, 'trajectoryEmptyArguments')).toBe(
      messages[language].trajectoryEmptyArguments
    )
  }
})

test('multiple numeric parameters render in both languages', () => {
  expect(translate('en', 'trajectoryShowing', { shown: 2, total: 10 })).toBe(
    'Showing 2 of 10 messages'
  )
  expect(translate('zh', 'trajectoryShowing', { shown: 2, total: 10 })).toBe('显示 2 / 10 条消息')
})

test('both catalogs have matching keys and interpolation parameters', () => {
  expect(Object.keys(messages.en).sort()).toStrictEqual(Object.keys(messages.zh).sort())
  for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
    const parameters = (text: string): string[] =>
      [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))].sort()
    expect(parameters(messages.en[key]), key).toStrictEqual(parameters(messages.zh[key]))
  }
})
