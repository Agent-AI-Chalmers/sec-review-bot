import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { expect, test } from 'vitest'

test('isolated Git behavior', () => {
  fs.mkdirSync('repo')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: 'repo', encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  expect(git('check-attr', 'eol', '--', 'sample.txt')).toBe(
    'sample.txt: eol: unspecified'
  )
  fs.writeFileSync('repo/.gitattributes', '*.txt text eol=lf\n')
  expect(git('check-attr', 'eol', '--', 'sample.txt')).toBe(
    'sample.txt: eol: lf'
  )
  fs.writeFileSync('repo/sample.txt', 'hello\n')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  fs.unlinkSync('repo/sample.txt')
  git('checkout', '--', 'sample.txt')
  expect(fs.readFileSync('repo/sample.txt', 'utf8')).toBe('hello\n')
})
