import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'

test('isolated Git behavior', () => {
  fs.mkdirSync('repo')
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: 'repo', encoding: 'utf8' }).trim()
  git('init', '-q')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.com')
  assert.equal(
    git('check-attr', 'eol', '--', 'sample.txt'),
    'sample.txt: eol: unspecified'
  )
  fs.writeFileSync('repo/.gitattributes', '*.txt text eol=lf\n')
  assert.equal(
    git('check-attr', 'eol', '--', 'sample.txt'),
    'sample.txt: eol: lf'
  )
  fs.writeFileSync('repo/sample.txt', 'hello\n')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  fs.unlinkSync('repo/sample.txt')
  git('checkout', '--', 'sample.txt')
  assert.equal(fs.readFileSync('repo/sample.txt', 'utf8'), 'hello\n')
})
