import assert from 'node:assert/strict'
import test from 'node:test'

import { messages, translate } from '../browser/shared/i18n.js'

test('file names are literal values, including replacement syntax and placeholders', () => {
  for (const language of ['en', 'zh'] as const) {
    for (const file of ["cost-$&-$$-$`-$'.md", '{file}-{count}.md']) {
      assert.equal(
        translate(language, 'deleteFileWarning', { file }),
        messages[language].deleteFileWarning.split('{file}').join(file)
      )
    }
    assert.equal(
      translate(language, 'trajectoryEmptyArguments'),
      messages[language].trajectoryEmptyArguments
    )
  }
})

test('multiple numeric parameters render in both languages', () => {
  assert.equal(
    translate('en', 'trajectoryShowing', { shown: 2, total: 10 }),
    'Showing 2 of 10 messages'
  )
  assert.equal(
    translate('zh', 'trajectoryShowing', { shown: 2, total: 10 }),
    '显示 2 / 10 条消息'
  )
})

test('both catalogs have matching keys and interpolation parameters', () => {
  assert.deepEqual(
    Object.keys(messages.en).sort(),
    Object.keys(messages.zh).sort()
  )
  for (const key of Object.keys(messages.en) as (keyof typeof messages.en)[]) {
    const parameters = (text: string): string[] =>
      [
        ...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))
      ].sort()
    assert.deepEqual(
      parameters(messages.en[key]),
      parameters(messages.zh[key]),
      key
    )
  }
})
