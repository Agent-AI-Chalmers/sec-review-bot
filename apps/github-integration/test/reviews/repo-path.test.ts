// Unit coverage for the repository-path validators.
//
// These are security controls: a model-authored or remotely supplied path reaches `git` and the
// GitHub contents API, so a path that escapes the repository, targets `.git`, or rewrites a
// security control (CI workflows, CODEOWNERS) must be rejected. The publish paths exercise them
// indirectly, but only for two sample values; the cases below pin each branch of the check.
import { expect, test } from 'vitest'

import {
  validateContractPublishableRepoRelativePath,
  validateRepoRelativePath,
  validateRepoRelativePathShape
} from '../../src/reviews/repo-path.js'

test('accepts ordinary repository-relative paths unchanged', () => {
  for (const path of [
    'src/app.ts',
    'a/b/c/d.txt',
    '.github/ISSUE_TEMPLATE/bug.md',
    'docs/CODEOWNERS.md',
    'file-with.dots.md'
  ]) {
    expect(validateRepoRelativePath(path)).toBe(path)
    expect(validateContractPublishableRepoRelativePath(path)).toBe(path)
  }
})

test('rejects paths that are empty, whitespace-padded, or absolute', () => {
  // Each of these would address a different file than the one named, or leave the repository.
  for (const path of [
    '',
    '   ',
    ' src/app.ts',
    'src/app.ts ',
    '/etc/passwd',
    'C:/Windows/system32',
    'c:relative'
  ]) {
    expect(
      () => validateRepoRelativePathShape(path),
      `${JSON.stringify(path)} must be rejected`
    ).toThrow(/Unsafe repository file path/)
  }
})

test('rejects traversal segments, empty segments, and dot segments', () => {
  for (const path of ['workspace/../x', '../outside', 'a/./b', 'a//b', 'a/..', './a']) {
    expect(
      () => validateRepoRelativePathShape(path),
      `${JSON.stringify(path)} must be rejected`
    ).toThrow(/Unsafe repository file path/)
  }
})

test('rejects backslashes, which some platforms would treat as separators', () => {
  expect(() => validateRepoRelativePathShape('a\\b.txt')).toThrow(/Unsafe repository file path/)
})

test('rejects any path that touches .git', () => {
  // `.git/config` could redirect where objects are written; a nested `.git` is still refused.
  for (const path of ['.git/config', 'sub/.git/HEAD', '.git']) {
    expect(() => validateRepoRelativePathShape(path)).toThrow(
      /Unsafe repository file path targets \.git/
    )
  }
})

test('normalizes trimming and backslashes before checking the shape', () => {
  // `validateRepoRelativePath` repairs a slash-separated path, then re-validates it.
  expect(validateRepoRelativePath(' src/app.ts ')).toBe('src/app.ts')
})

test('rejects security-control paths in both publishing validators', () => {
  // These decide what CI runs and who reviews: a model-authored PR must not rewrite them
  // implicitly.
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows',
    'CODEOWNERS',
    '.github/CODEOWNERS',
    'docs/CODEOWNERS'
  ]) {
    expect(
      () => validateRepoRelativePath(path),
      `${JSON.stringify(path)} must be rejected by validateRepoRelativePath`
    ).toThrow(/Sensitive repository file path/)
    expect(
      () => validateContractPublishableRepoRelativePath(path),
      `${JSON.stringify(path)} must be rejected by validateContractPublishableRepoRelativePath`
    ).toThrow(/Sensitive repository file path/)
  }
})

test('the structural check alone permits a sensitive path', () => {
  // `validateRepoRelativePathShape` is contract-shape only; policy lives in the two validators.
  // Pinning that keeps a future refactor from silently moving policy into the shape check (or
  // removing it from the validators).
  expect(validateRepoRelativePathShape('.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml')
})
