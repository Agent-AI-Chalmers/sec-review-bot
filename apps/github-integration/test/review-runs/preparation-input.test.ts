import assert from 'node:assert/strict'
import test from 'node:test'
import { extractIssueContext } from '../../src/github/issue-service.js'
import { extractPullRequestContext } from '../../src/github/pull-request-service.js'
import {
  parseIssuePreparationInput,
  parsePullRequestPreparationInput,
  type IssuePreparationInput,
  type PullRequestPreparationInput
} from '../../src/review-runs/preparation-input.js'
import { InvalidPreparationInputError } from '../../src/review-runs/preparation-failure.js'

const trusted_default_branch = { default_branch: 'main', head_sha: 'trusted' }
const repository = {
  name: 'example',
  full_name: 'octo/example',
  owner: { login: 'octo' },
  default_branch: 'main'
}
function issueInput(): IssuePreparationInput {
  return {
    kind: 'github_issue_review',
    issue: extractIssueContext({
      action: 'opened',
      repository,
      issue: { number: 1, title: 'Claim', state: 'open' }
    }),
    trusted_default_branch,
    event_type: 'manual_review',
    review_objective: 'repair',
    test_changes: 'deny',
    open_pr: true
  }
}
function prInput(): PullRequestPreparationInput {
  return {
    kind: 'github_pull_request_review',
    pr: extractPullRequestContext({
      action: 'synchronize',
      before: 'previous',
      repository,
      pull_request: {
        number: 7,
        title: 'Change',
        base: { ref: 'main', sha: 'base' },
        head: { ref: 'topic', sha: 'head' }
      }
    }),
    trusted_default_branch,
    event_type: 'synchronize',
    test_changes: null
  }
}

test('extracted issue input survives persistence with unknown logins and empty metadata', () => {
  const input = issueInput()
  const json: unknown = JSON.parse(JSON.stringify(input))
  assert.deepStrictEqual(parseIssuePreparationInput(json), input)
})

test('extracted PR snapshot survives persistence without changing its push window', () => {
  const input = prInput()
  assert.deepStrictEqual(
    parsePullRequestPreparationInput(JSON.parse(JSON.stringify(input))),
    input
  )
})

test('issue recovery rejects invalid event and policy values', () => {
  for (const [field, value] of [
    ['event_type', 'synchronize'],
    ['event_type', undefined],
    ['review_objective', 'unknown'],
    ['review_objective', undefined],
    ['test_changes', 'sometimes'],
    ['test_changes', undefined],
    ['open_pr', 'true'],
    ['open_pr', undefined]
  ]) {
    assert.throws(
      () => parseIssuePreparationInput({ ...issueInput(), [field!]: value }),
      InvalidPreparationInputError
    )
  }
})

test('PR recovery validates references and policies before performing GitHub work', () => {
  const input = {
    ...prInput(),
    pr: undefined,
    pr_reference: { owner_login: 'octo', repo_name: 'example', pr_number: 7 }
  }
  assert.deepStrictEqual(
    parsePullRequestPreparationInput(JSON.parse(JSON.stringify(input))),
    {
      kind: input.kind,
      pr_reference: input.pr_reference,
      trusted_default_branch,
      event_type: 'synchronize',
      test_changes: null
    }
  )
  for (const pr_number of ['7', null, 0, -1, 1.5]) {
    assert.throws(
      () =>
        parsePullRequestPreparationInput({
          ...input,
          pr_reference: { ...input.pr_reference, pr_number }
        }),
      InvalidPreparationInputError
    )
  }
  for (const changes of [
    { event_type: 'typo' },
    { test_changes: false },
    { pr: null },
    { pr_reference: null }
  ]) {
    assert.throws(
      () => parsePullRequestPreparationInput({ ...input, ...changes }),
      InvalidPreparationInputError
    )
  }
})

test('old reference checkpoints recover their captured snapshot rather than the reference', () => {
  const input = prInput()
  assert.deepStrictEqual(
    parsePullRequestPreparationInput({
      ...input,
      pr_reference: { owner_login: 'octo', repo_name: 'example', pr_number: 7 }
    }),
    input
  )
})
